"""Small offline regressions: no provider calls, model downloads or private assets."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
from unittest.mock import Mock, patch
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parents[1]

def load(name, relative):
    spec = importlib.util.spec_from_file_location(name, ROOT / relative)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module

sprite = load("sprite", "tools/image/prepare-sprite.py")
review = load("review", "tools/authoring/build-portrait-review.py")
generate = load("generate", "tools/image/generate-image.py")

class ToolTests(unittest.TestCase):
    def test_image_url_download_has_no_api_auth_and_checks_output(self):
        png = b"\x89PNG\r\n\x1a\nlocal mock image"
        response = Mock(status=200)
        response.getheader.return_value = str(len(png))
        response.read1.side_effect = [png, b""]
        connection = Mock(sock=None)
        connection.getresponse.return_value = response
        with tempfile.TemporaryDirectory() as directory, patch.object(generate, "PublicHTTPSConnection", return_value=connection) as factory:
            output = Path(directory) / "image.png"
            generate.save_response({"data": [{"url": "https://images.example/image.png?signature=SECRET"}]}, output)
            self.assertEqual(output.read_bytes(), png)
            factory.assert_called_once_with("images.example", timeout=30)
            connection.request.assert_called_once_with("GET", "/image.png?signature=SECRET", headers={"Accept": "image/*"})
            connection.close.assert_called_once()

    def test_image_url_blocks_unsafe_targets_before_connecting(self):
        for value in ["http://images.example/a", "https://user:SECRET@images.example/a", "https://images.example:444/a", "https://images.example/a#SECRET", "https://images.example/a\nSECRET"]:
            with self.subTest(value=value), patch.object(generate, "PublicHTTPSConnection") as connection:
                with self.assertRaises(generate.ImageResponseError) as error:
                    generate.download_image(value)
                self.assertNotIn("SECRET", str(error.exception))
                connection.assert_not_called()
        for addresses in [["127.0.0.1"], ["10.0.0.1"], ["169.254.169.254"], ["::1"], ["::ffff:127.0.0.1"], ["224.0.0.1"], ["fec0::1"], ["93.184.216.34", "192.168.1.1"]]:
            resolved = [(generate.socket.AF_INET, generate.socket.SOCK_STREAM, 6, "", (ip, 443)) for ip in addresses]
            with self.subTest(addresses=addresses), patch.object(generate.socket, "getaddrinfo", return_value=resolved), patch.object(generate.socket, "create_connection") as connect:
                with self.assertRaises(generate.ImageResponseError):
                    generate.PublicHTTPSConnection("images.example").connect()
                connect.assert_not_called()

    def test_image_connection_pins_ip_and_keeps_tls_hostname(self):
        resolved = [(generate.socket.AF_INET, generate.socket.SOCK_STREAM, 6, "", ("93.184.216.34", 443))]
        context = Mock()
        with patch.object(generate.socket, "getaddrinfo", return_value=resolved), patch.object(generate.socket, "create_connection") as connect:
            connection = generate.PublicHTTPSConnection("images.example", timeout=30, context=context)
            connection.connect()
            connect.assert_called_once_with(("93.184.216.34", 443), 30)
            context.wrap_socket.assert_called_once_with(connect.return_value, server_hostname="images.example")
            connection.close()

    def test_image_download_rejects_redirects_truncation_and_large_bodies(self):
        cases = [(302, "0", [], "重定向"), (403, "0", [], "HTTP 200"),
                 (200, "999999999", [], "50 MiB"), (200, "invalid", [], "Content-Length"),
                 (200, "4", [b"abc", b""], "不完整"),
                 (200, None, [b"123456789"], "50 MiB")]
        for status, length, chunks, message in cases:
            connection = Mock(sock=None)
            response = Mock(status=status)
            response.getheader.return_value = length
            response.read1.side_effect = chunks
            connection.getresponse.return_value = response
            with self.subTest(status=status, length=length), patch.object(generate, "PublicHTTPSConnection", return_value=connection), patch.object(generate, "MAX_BYTES", 8):
                with self.assertRaisesRegex(generate.ImageResponseError, message):
                    generate.download_image("https://images.example/SECRET")
                self.assertEqual(connection.request.call_count, 1)
                connection.close.assert_called_once()
        connection = Mock(sock=None)
        connection.request.side_effect = OSError("https://images.example/SECRET provider body")
        with patch.object(generate, "PublicHTTPSConnection", return_value=connection):
            with self.assertRaises(generate.ImageResponseError) as error:
                generate.download_image("https://images.example/SECRET")
            self.assertNotIn("SECRET", str(error.exception))

    def test_image_download_deadline_and_timeout_are_safe(self):
        connection = Mock(sock=None)
        with patch.object(generate, "PublicHTTPSConnection", return_value=connection), patch.object(generate.time, "monotonic", side_effect=[0, 31]):
            with self.assertRaisesRegex(generate.ImageResponseError, "超时"):
                generate.download_image("https://images.example/SECRET")
            connection.getresponse.assert_not_called()
        connection.request.side_effect = TimeoutError("SECRET")
        with patch.object(generate, "PublicHTTPSConnection", return_value=connection):
            with self.assertRaisesRegex(generate.ImageResponseError, "超时") as error:
                generate.download_image("https://images.example/SECRET")
            self.assertNotIn("SECRET", str(error.exception))

    def test_image_response_shapes_are_friendly_and_do_not_create_output(self):
        invalid = [None, [], {}, {"data": []}, {"data": [None]}, {"data": [{}]},
                   {"data": [{"b64_json": "SECRET!"}]}, {"data": [{"url": 123}]}]
        with tempfile.TemporaryDirectory() as directory:
            output = Path(directory) / "image.png"
            for payload in invalid:
                with self.subTest(payload=payload), self.assertRaises(generate.ImageResponseError) as error:
                    generate.save_response(payload, output)
                self.assertNotIn("SECRET", str(error.exception))
                self.assertFalse(output.exists())

    def test_masked_edit_preserves_mask_payload(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            Image.new("RGBA", (5, 5), "red").save(root / "input.png")
            Image.new("RGBA", (5, 5), (255, 255, 255, 0)).save(root / "mask.png")
            body, content = generate.build_body("Repair sides", "project-model", "1024x1536", [root / "input.png"], "transparent", root / "mask.png")
            self.assertIn("multipart/form-data", content)
            self.assertEqual(body.count(b'name="mask"'), 1)
            self.assertIn((root / "mask.png").read_bytes(), body)
            with self.assertRaises(ValueError):
                generate.build_body("Repair sides", "project-model", "1024x1536", [], mask=root / "mask.png")

    def test_contain_and_alpha_are_preserved(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new("RGBA", (200, 100))
            ImageDraw.Draw(image).rectangle((10, 10, 189, 89), fill=(30, 40, 50, 128))
            image.save(root / "input.png")
            info = sprite.prepare(root / "input.png", root / "out.png", 100, 140, 10)
            self.assertEqual(info["subject_size"], [80, 36])
            output = Image.open(root / "out.png")
            self.assertEqual(output.getpixel((50, 110))[3], 128)  # No double alpha masking.
            self.assertFalse(info["needs_redraw_review"])
            self.assertEqual(output.getpixel((0, 0))[3], 0)

    def test_original_clipping_is_reported_before_padding(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new("RGBA", (40, 50))
            ImageDraw.Draw(image).rectangle((0, 0, 30, 49), fill="red")
            image.save(root / "input.png")
            info = sprite.prepare(root / "input.png", root / "out.webp", 100, 140, 20)
            self.assertTrue(info["source_edges"]["top"])
            self.assertTrue(info["source_edges"]["left"])
            self.assertTrue(info["needs_redraw_review"])
            self.assertEqual(Image.open(root / "out.webp").getpixel((0, 0))[3], 0)

    def test_half_body_bottom_aligns_without_cropping_head_or_sides(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            image = Image.new("RGBA", (80, 120))
            ImageDraw.Draw(image).rectangle((20, 10, 59, 119), fill="red")
            image.save(root / "input.png")
            info = sprite.prepare(root / "input.png", root / "out.webp", 100, 140, 10, bottom_padding=0)
            output = Image.open(root / "out.webp")
            box = output.getchannel("A").getbbox()
            self.assertEqual(box[3], 140)
            self.assertGreaterEqual(box[0], 10)
            self.assertGreaterEqual(box[1], 10)
            self.assertFalse(info["needs_redraw_review"])

    def test_flood_keeps_enclosed_background_color_and_rejects_opaque_alpha_mode(self):
        image = Image.new("RGBA", (30, 30), "white")
        draw = ImageDraw.Draw(image)
        draw.rectangle((5, 5, 24, 24), fill="black")
        draw.rectangle((10, 10, 19, 19), fill="white")
        cut = sprite.flood_cutout(image, 10, (255, 255, 255))
        self.assertEqual(cut.getpixel((0, 0))[3], 0)
        self.assertEqual(cut.getpixel((12, 12))[3], 255)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); image.save(root / "opaque.png")
            with self.assertRaises(ValueError):
                sprite.prepare(root / "opaque.png", root / "out.png")

    def test_review_is_self_contained_and_rejects_escape(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory); assets = root / "source"; assets.mkdir()
            Image.new("RGBA", (10, 20), (10, 20, 30, 128)).save(assets / "portrait.png")
            manifest = root / "manifest.json"
            manifest.write_text(json.dumps({"title": "<Title>", "characters": {"one": {"name": "<Name>", "portrait": "portrait.png", "expressions": {"same": "portrait.png"}}}}))
            result = review.build_review(manifest, assets, root / "review")
            self.assertEqual(result["images"], 1)
            page = (root / "review/index.html").read_text()
            self.assertIn('&lt;Name&gt;', page)
            self.assertIn('class="dark"', page); self.assertIn('class="light"', page)
            self.assertEqual(page.count('src="assets/0000.png"'), 2)
            self.assertTrue((root / "review/assets/0000.png").is_file())
            (root / "outside.png").write_bytes(b"private")
            manifest.write_text(json.dumps({"characters": {"one": {"portrait": "../outside.png"}}}))
            with self.assertRaises(ValueError):
                review.build_review(manifest, assets, root / "bad-review")
            self.assertFalse((root / "bad-review").exists())

    def test_generation_preview_and_multi_reference_body_are_offline(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            for name in ["one.png", "two.png"]:
                Image.new("RGBA", (5, 5), "red").save(root / name)
            body, content = generate.build_body("Prompt", "project-model", "1024x1536", [root / "one.png", root / "two.png"])
            self.assertIn("multipart/form-data", content)
            self.assertEqual(body.count(b'name="image[]"'), 2)
            (root / "prompt.txt").write_text("A generic test prompt.")
            result = subprocess.run(["python3", str(ROOT / "tools/image/generate-image.py"), "--endpoint", "https://invalid.example/generate", "--model", "project-model", "--prompt-file", str(root / "prompt.txt"), "--out", str(root / "out.png")], capture_output=True, text=True, check=True)
            self.assertFalse(json.loads(result.stdout)["network"])
            self.assertFalse((root / "out.png").exists())
            image = (root / "one.png").read_bytes()
            generate.save_response({"data": [{"b64_json": base64.b64encode(image).decode()}]}, root / "saved.png")
            self.assertEqual((root / "saved.png").read_bytes(), image)
            with self.assertRaises(ValueError):
                generate.save_response({"data": [{"b64_json": base64.b64encode(image).decode()}]}, root / "wrong.webp")

if __name__ == "__main__":
    unittest.main()

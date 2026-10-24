"""Small offline regressions: no provider calls, model downloads or private assets."""
import base64
import importlib.util
import json
from pathlib import Path
import subprocess
import tempfile
import unittest
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

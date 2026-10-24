#!/usr/bin/env node
import { copyFile, mkdir } from 'node:fs/promises';
const root = new URL('../', import.meta.url), out = new URL('build/minimal/', root);
await mkdir(out, { recursive: true });
for (const name of ['index.html', 'app.js', 'story.json']) await copyFile(new URL(`examples/minimal/${name}`, root), new URL(name, out));
for (const name of ['module-api', 'content', 'core', 'save', 'web-adapter']) {
  await mkdir(new URL(`runtime/${name}/`, out), { recursive: true });
  await copyFile(new URL(`packages/${name}/dist/index.js`, root), new URL(`runtime/${name}/index.js`, out));
}
console.log('示例已构建：build/minimal/；用任意静态 HTTP 服务打开。');

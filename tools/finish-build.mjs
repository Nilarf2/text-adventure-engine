import { cp, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);
for (const name of await readdir(new URL('dist/', root))) {
  await cp(new URL(`dist/${name}/src/`, root), new URL(`packages/${name}/dist/`, root), { recursive: true });
}
console.log(`Built workspace packages in ${fileURLToPath(root)}`);

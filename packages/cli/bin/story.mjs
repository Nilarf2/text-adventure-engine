#!/usr/bin/env node
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { validateStory, formatDiagnostics, compileStory } from '../../../dist/content/src/index.js';
import { createSession } from '../../../dist/core/src/index.js';

const { values: options, positionals: [command, inputArg] } = parseArgs({ allowPositionals: true, options: { json: { type: 'boolean' }, out: { type: 'string' }, modules: { type: 'string' } } });
const json = options.json;
if (!command || !inputArg || !['validate', 'compile', 'inspect', 'run'].includes(command)) {
  console.error('Usage: story <validate|compile|inspect|run> <story.json> [--json] [--out <dir>] [--modules <module.mjs>]');
  process.exitCode = 2;
} else {
  const inputPath = resolve(inputArg);
  try {
    const story = JSON.parse(await readFile(inputPath, 'utf8'));
    const modules = options.modules ? (await import(pathToFileURL(resolve(options.modules)).href)).default : [];
    const validation = validateStory(story, modules);
    if (command === 'validate') {
      console.log(formatDiagnostics(validation, json ? 'json' : 'text'));
      if (!validation.valid) process.exitCode = 1;
    } else {
      const compiled = compileStory(story, modules);
      if (command === 'inspect') {
        console.log(JSON.stringify({ id: story.id, version: story.version, title: story.title, start: story.start, nodes: story.nodes.map(({ id, type }) => ({ id, type })) }, null, 2));
      } else if (command === 'compile') {
        const outDir = resolve(options.out ?? 'build/story');
        await mkdir(outDir, { recursive: true });
        const file = resolve(outDir, 'story.compiled.json');
        await writeFile(file, `${JSON.stringify(story, null, 2)}\n`);
        console.log(`Compiled ${story.id}: ${relative(process.cwd(), file)}`);
      } else {
        const session = createSession(compiled);
        const first = session.start();
        console.log(JSON.stringify({ view: first.view, events: first.events, effects: first.effects }, null, 2));
      }
    }
  } catch (error) {
    if (json) console.error(JSON.stringify({ error: error instanceof Error ? error.message : String(error), file: inputPath }));
    else console.error(`${relative(process.cwd(), inputPath)}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}

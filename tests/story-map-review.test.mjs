import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { buildMap, validateEvidence } from '../tools/authoring/build-story-map.mjs';
import { compileStory } from '../packages/content/dist/index.js';
import { createSession } from '../packages/core/dist/index.js';

const end = { id: 'end', type: 'end', ending: 'done' };
const story = nodes => ({ schemaVersion: '1', id: 'map-test', version: '1', title: 'Map test', start: nodes[0].id, nodes });
const evidenceFor = input => {
  const session = createSession(compileStory(input), { seed: 1 });
  const trace = [session.start().view];
  while (session.getView().awaiting !== 'ended') trace.push(session.dispatch({ type: 'continue' }).view);
  return { storyId: input.id, contentVersion: input.version, seed: 1, ending: 'done', trace, snapshot: session.snapshot() };
};

test('static diagnostics exclude normal endings and identify disconnected cycles and dead ends', () => {
  const data = buildMap(story([
    { id: 'intro', type: 'narration', lines: [{ text: 'Start' }], next: 'end' }, { ...end, next: 'lost' },
    { id: 'lost', type: 'action', actions: [] },
    { id: 'cycleA', type: 'action', actions: [], next: 'cycleB' },
    { id: 'cycleB', type: 'action', actions: [], next: 'cycleA' }
  ]));
  assert.deepEqual(data.analysis.reachable, ['intro', 'end']);
  assert.deepEqual(data.analysis.unreachable, ['lost', 'cycleA', 'cycleB']);
  assert.deepEqual(data.analysis.orphan, ['lost']);
  assert.deepEqual(data.analysis.deadEnds, ['lost']);
  assert.deepEqual(data.analysis.cannotReachEnd, ['lost', 'cycleA', 'cycleB']);
});

test('condition edges remain possible edges and are never claimed to be executable', () => {
  const data = buildMap(story([{ id: 'choice', type: 'choice', options: [{ id: 'hidden', text: 'Hidden', next: 'end', when: { op: 'tag', tag: 'absent' } }, { id: 'other', text: 'Other', next: 'otherEnd', disabledWhen: { op: 'tag', tag: 'disabled' } }] }, end, { id: 'otherEnd', type: 'end', ending: 'other' }]));
  assert.equal(data.analysis.conditionalEdges, 2);
  assert.deepEqual(data.analysis.unreachable, []);
  assert.deepEqual(data.analysis.cannotReachEnd, []);
  assert.ok(data.analysis.notes.some(note => note.includes('不证明')));
});

test('custom targets and host-dependent modules are marked unknown rather than certain failures', () => {
  const custom = buildMap(story([{ id: 'custom', type: 'stage:jump' }, end]));
  assert.deepEqual(custom.analysis.unreachable, []);
  assert.deepEqual(custom.analysis.unknownReachability, ['end']);
  assert.deepEqual(custom.analysis.deadEnds, []);
  assert.deepEqual(custom.analysis.unknownEnd, ['custom']);
  const module = buildMap(story([{ id: 'request', type: 'module', module: 'probe', outcomes: { retry: 'request' } }, end]));
  assert.deepEqual(module.analysis.deadEnds, []);
  assert.deepEqual(module.analysis.unknownEnd, ['request']);
  assert.deepEqual(module.analysis.cannotReachEnd, []);
});

test('evidence highlights positive visits including automatic nodes without inventing trace entries or edges', () => {
  const input = story([{ id: 'intro', type: 'narration', lines: [{ text: '<img src=x onerror=alert(1)>' }], next: 'auto' }, { id: 'auto', type: 'action', actions: [], next: 'end' }, end]);
  const raw = evidenceFor(input), checked = validateEvidence(raw, buildMap(input));
  assert.deepEqual(checked.visited.map(item => item.id), ['intro', 'auto', 'end']);
  assert.deepEqual(checked.trace.map(item => item.nodeId), ['intro', 'end']);
  assert.equal(checked.trace[0].line.text, '<img src=x onerror=alert(1)>');
  assert.equal(checked.edges, undefined);
  assert.equal(checked.commands, undefined);
  checked.trace[0].line.text = 'Changed';
  assert.notEqual(raw.trace[0].line.text, checked.trace[0].line.text);
});

test('evidence rejects mismatched identity, malformed state, unknown visits and impossible wait types', () => {
  const input = story([{ id: 'intro', type: 'narration', lines: [{ text: 'Start' }], next: 'end' }, end]);
  const raw = evidenceFor(input), data = buildMap(input);
  for (const mutate of [
    value => value.storyId = 'another', value => value.contentVersion = 'old',
    value => value.snapshot.contentVersion = 'old', value => value.snapshot.state.visits.foreign = 1,
    value => value.snapshot.state.visits.intro = 0, value => value.trace[0].awaiting = 'choice',
    value => value.snapshot.state.variables.unknown = true, value => value.snapshot.state.randomState = -1,
    value => value.snapshot.state.modules.bad = { version: 0 }, value => value.snapshot.state.audio.music = { asset: 'x', loop: true, volume: 2 },
    value => value.trace = [], value => value.snapshot.state.pending = { id: 'old' }
  ]) {
    const invalid = structuredClone(raw); mutate(invalid);
    assert.throws(() => validateEvidence(invalid, data));
  }

});

test('actual check-route output with inherited-name IDs imports without prototype mutation', async () => {
  const build = resolve('build'); await mkdir(build, { recursive: true });
  const directory = await mkdtemp(join(build, 'map-review-test-'));
  try {
    const input = story([{ id: 'toString', type: 'narration', lines: [{ text: 'Inherited names are IDs.' }], next: 'hasOwnProperty' }, { id: 'hasOwnProperty', type: 'action', actions: [], next: 'valueOf' }, { id: 'valueOf', type: 'end', ending: 'done' }]);
    const source = join(directory, 'story.json'), route = join(directory, 'route-input.json'), output = join(directory, 'route.json');
    await writeFile(source, JSON.stringify(input));
    await writeFile(route, JSON.stringify({ seed: 1, steps: [{ node: 'toString', command: { type: 'continue' } }], ending: 'done' }));
    const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
    execFileSync(process.execPath, ['tools/authoring/check-route.mjs', '--story', source, '--route', route, '--out', output]);
    const actual = JSON.parse(await readFile(output, 'utf8'));
    const checked = validateEvidence(actual, buildMap(input));
    for (const name of ['toString', 'hasOwnProperty', 'valueOf']) {
      assert.equal(Object.hasOwn(checked.snapshot.state.visits, name), true);
      assert.equal(checked.snapshot.state.visits[name], 1);
    }
    execFileSync(process.execPath, ['tools/authoring/build-story-map.mjs', '--story', source, '--out', join(directory, 'map'), '--trace', output]);
    assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
    const data = JSON.parse(await readFile(join(directory, 'map/story-map.json'), 'utf8'));
    assert.equal(data.evidence.ending, 'done');
    assert.equal(data.evidence.visited.length, 3);
    assert.ok((await readFile(join(directory, 'map/index.html'), 'utf8')).includes('./review-data.js'));
    assert.ok((await readFile(join(directory, 'map/review-data.js'), 'utf8')).includes('validateEvidence'));
  } finally { await rm(directory, { recursive: true, force: true }); }
});


test('JSON constructor/prototype/__proto__ keys remain data in imported and embedded evidence', async () => {
  const input = story([{ id: 'intro', type: 'narration', lines: [{ text: 'Start' }], next: 'end' }, end]);
  const raw = evidenceFor(input);
  raw.snapshot.state.modules.probe = { version: 1, data: JSON.parse('{"constructor":{"prototype":{"__proto__":{"reviewProbe":true}}}}') };
  raw.snapshot.moduleVersions.probe = '1';
  const prototypeBefore = Object.getOwnPropertyDescriptors(Object.prototype);
  const checked = validateEvidence(raw, buildMap(input));
  assert.equal(Object.hasOwn(checked.snapshot.state.modules.probe.data.constructor.prototype, '__proto__'), true);
  assert.equal(checked.snapshot.state.modules.probe.data.constructor.prototype.__proto__.reviewProbe, true);
  assert.equal(Object.hasOwn(Object.prototype, 'reviewProbe'), false);
  const build = resolve('build'); await mkdir(build, { recursive: true });
  const directory = await mkdtemp(join(build, 'map-key-test-'));
  try {
    await writeFile(join(directory, 'story.json'), JSON.stringify(input));
    await writeFile(join(directory, 'route.json'), JSON.stringify(raw));
    execFileSync(process.execPath, ['tools/authoring/build-story-map.mjs', '--story', join(directory, 'story.json'), '--out', join(directory, 'map'), '--trace', join(directory, 'route.json')]);
    const { runInNewContext } = await import('node:vm');
    const sandbox = {};
    runInNewContext(await readFile(join(directory, 'map/story-map-data.js'), 'utf8'), sandbox);
    const data = sandbox.STORY_MAP.evidence.snapshot.state.modules.probe.data;
    assert.equal(Object.hasOwn(data.constructor.prototype, '__proto__'), true);
    assert.equal(data.constructor.prototype.__proto__.reviewProbe, true);
    assert.equal(Object.getPrototypeOf(data.constructor.prototype).reviewProbe, undefined);
  } finally { await rm(directory, { recursive: true, force: true }); }
  assert.deepEqual(Object.getOwnPropertyDescriptors(Object.prototype), prototypeBefore);
});

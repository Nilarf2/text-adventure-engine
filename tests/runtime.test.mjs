import test from 'node:test';
import assert from 'node:assert/strict';
import { compileStory, validateStory } from '../packages/content/dist/index.js';
import { createSession } from '../packages/core/dist/index.js';
import { createModuleRegistry } from '../packages/module-api/dist/index.js';
import { prepareSnapshot, validateSnapshot } from '../packages/save/dist/index.js';
import { LocalStorageSaveStore, WebAudioAdapter } from '../packages/web-adapter/dist/index.js';
import { buildMap } from '../tools/authoring/build-story-map.mjs';

const ending = { id: 'end', type: 'end', ending: 'done' };
const story = (nodes, extra = {}) => ({ schemaVersion: '1', id: 'test', version: '1', title: 'Test', start: nodes[0].id, nodes, ...extra });
const intro = { id: 'intro', type: 'narration', lines: [{ text: 'Start' }], next: 'end' };

test('restore replaces optional state and reconciles absent audio without replaying onEnter', () => {
  const probe = { id: 'probe', version: '1', register() {} };
  const data = story([{ id: 'scene', type: 'scene', scene: 'room', background: 'room', music: 'music', onEnter: [{ type: 'checkpoint', name: 'here' }], next: 'module' }, { id: 'module', type: 'module', module: 'probe', outcomes: { done: 'end' } }, ending]);
  const session = createSession(compileStory(data, [probe]));
  const initial = session.snapshot();
  session.start();
  assert.ok(session.snapshot().state.pending);
  let restored = session.restore(initial);
  assert.deepEqual(session.snapshot(), initial);
  assert.deepEqual(restored.effects, [{ type: 'audio.stop', channel: 'music' }, { type: 'audio.stop', channel: 'ambience' }]);
  session.start();
  session.dispatch({ type: 'module.result', requestId: session.getView().pending.id, outcome: 'done' });
  assert.ok(session.getView().ending);
  session.restore(initial);
  assert.equal(session.getView().ending, undefined);
});

test('view exceptions cannot commit a transaction', () => {
  const mod = { id: 'probe', version: '1', register(r) { r.condition('probe:fail', () => { throw Error('view failed'); }); } };
  const compiled = compileStory(story([{ ...intro, next: 'choice' }, { id: 'choice', type: 'choice', options: [{ id: 'a', text: 'A', next: 'end' }, { id: 'b', text: 'B', next: 'end', when: { op: 'probe:fail' } }] }, ending]), [mod]);
  const session = createSession(compiled); session.start();
  const before = session.snapshot();
  assert.throws(() => session.dispatch({ type: 'continue' }), /view failed/);
  assert.deepEqual(session.snapshot(), before);
});

test('numeric overflow and wrong plugin variable types roll back', () => {
  const mod = { id: 'probe', version: '1', register(r) { r.command('probe:bad', ctx => ctx.setVariable('count', 'bad')); } };
  const compiled = compileStory(story([{ ...intro, next: 'sum' }, { id: 'sum', type: 'action', actions: [{ type: 'add', variable: 'count', value: 1e308 }], next: 'end' }, ending], { variables: { count: { type: 'number', default: 1e308 } } }), [mod]);
  const session = createSession(compiled); session.start(); const before = session.snapshot();
  assert.throws(() => session.dispatch({ type: 'continue' }));
  assert.deepEqual(session.snapshot(), before);
  assert.throws(() => session.dispatch({ type: 'module.command', name: 'probe:bad' }), /must be number/);
  assert.deepEqual(session.snapshot(), before);
});

test('listener reporting errors do not invalidate committed commands', () => {
  const session = createSession(story([intro, ending]), { onListenerError() { throw Error('reporting'); } });
  session.subscribe(() => { throw Error('listener'); });
  assert.equal(session.start().view.awaiting, 'continue');
  assert.equal(session.dispatch({ type: 'continue' }).view.awaiting, 'ended');
});

test('empty choices take fallback and fail transactionally without one', () => {
  const node = { id: 'choice', type: 'choice', options: [{ id: 'hidden', text: 'Hidden', next: 'end', when: { op: 'tag', tag: 'missing' } }] };
  assert.equal(createSession(story([{ ...node, fallback: 'end' }, ending])).start().view.awaiting, 'ended');
  const session = createSession(story([node, ending])); const initial = session.snapshot();
  assert.throws(() => session.start(), /no selectable options/);
  assert.deepEqual(session.snapshot(), initial);
});

test('corrupt snapshot cursors, counters and pending requests fail before replacing state', () => {
  const compiled = compileStory(story([intro, ending])); const session = createSession(compiled); session.start();
  const original = session.snapshot();
  for (const mutate of [s => s.state.lineIndex = 10, s => s.state.awaiting = 'choice', s => s.state.revision = -1, s => s.state.randomState = 2**32, s => s.state.pending = { id: 'probe:1', module: 'probe', nodeId: 'intro', input: null }, s => s.state.variables.extra = 1]) {
    const invalid = structuredClone(original); mutate(invalid);
    assert.throws(() => session.restore(invalid));
    assert.deepEqual(session.snapshot(), original);
  }
  const old = structuredClone(original); old.engineVersion = '0.1.1';
  assert.doesNotThrow(() => session.restore(prepareSnapshot(old, compiled)));
  assert.throws(() => validateSnapshot({ ...original, state: { ...original.state, requestSequence: Number.MAX_SAFE_INTEGER + 1 } }));
});

test('compiled content and module metadata are detached from caller mutation', () => {
  const input = story([structuredClone(intro), structuredClone(ending)]);
  const mod = { id: 'probe', version: '1', initialState: { count: 1 }, register() {} };
  const compiled = compileStory(input, [mod]);
  input.nodes[0].lines[0].text = 'Changed'; mod.initialState.count = 999; mod.version = '2';
  const session = createSession(compiled);
  assert.equal(session.start().view.line.text, 'Start');
  assert.equal(session.snapshot().moduleVersions.probe, '1');
  assert.deepEqual(session.snapshot().state.modules.probe.data, { count: 1 });
});

test('content validation detects ambiguous options, undeclared variables and audio errors', () => {
  const input = story([{ id: 'choice', type: 'choice', onEnter: [{ type: 'audio.play', asset: 'x', channel: 'wrong', options: { volume: 2, fadeMs: -1 } }], options: [{ id: 'same', text: 'A', next: 'end', actions: [{ type: 'set', variable: 'missing', value: 1 }] }, { id: 'same', text: 'B', next: 'end' }] }, ending]);
  const result = validateStory(input);
  assert.equal(result.valid, false);
  for (const code of ['OPTION_DUPLICATE', 'VARIABLE_MISSING', 'AUDIO_CHANNEL', 'AUDIO_VOLUME', 'AUDIO_FADE']) assert.ok(result.diagnostics.some(d => d.code === code), code);
  const cyclic = story([intro, ending]); cyclic.self = cyclic;
  assert.equal(validateStory(cyclic).valid, false);
  assert.throws(() => createModuleRegistry([{ id: 'probe', version: '1', register(r) { r.capability('probe:', {}); } }]));
});

class StorageStub {
  records = new Map();
  get length() { return this.records.size; }
  key(index) { return [...this.records.keys()][index] ?? null; }
  getItem(key) { return this.records.get(key) ?? null; }
  setItem(key, value) { this.records.set(key, value); }
  removeItem(key) { this.records.delete(key); }
}

test('a corrupt local save cannot hide valid slots', async () => {
  const storage = new StorageStub(), store = new LocalStorageSaveStore(storage);
  const snapshot = createSession(story([intro, ending])).snapshot();
  await store.write({ slotId: 'good', snapshot, savedAt: '2026-01-01T00:00:00Z' });
  storage.setItem('text-adventure:save:v1:broken', '{');
  storage.setItem('text-adventure:save:v1:%invalid', '{}');
  assert.deepEqual((await store.list()).map(e => e.slotId), ['good']);
  await assert.rejects(() => store.read('broken'));
});

class AudioStub {
  paused = true; volume = 1; loop = false; onended = null; plays = 0; pauses = 0;
  async play() { this.plays++; this.paused = false; }
  pause() { this.paused = true; this.pauses++; }
  removeAttribute() {} load() {}
}

test('pause prevents gesture unlock from restarting music', async () => {
  const audio = new AudioStub();
  const adapter = new WebAudioAdapter({ assets: { theme: { type: 'audio', src: 'theme.ogg' } }, createAudio: () => audio });
  await adapter.playMusic('theme'); adapter.pause(); await adapter.unlock();
  assert.equal(audio.plays, 1); assert.equal(audio.paused, true); adapter.dispose();
});

test('pending audio completion cannot restart a disposed adapter', async () => {
  let finish;
  const audio = new AudioStub();
  audio.play = () => new Promise(resolve => { finish = () => { audio.paused = false; resolve(); }; });
  const adapter = new WebAudioAdapter({ resolveAsset: () => 'theme.ogg', createAudio: () => audio });
  const playing = adapter.playMusic('theme'); await Promise.resolve(); await Promise.resolve();
  adapter.dispose(); finish(); await playing;
  assert.equal(audio.paused, true);
});

test('story map includes choice fallback and extension next edges', () => {
  const data = buildMap(story([{ id: 'choice', type: 'choice', options: [{ id: 'a', text: '<script>', next: 'custom' }], fallback: 'end' }, { id: 'custom', type: 'stage:set', next: 'end' }, ending]));
  assert.equal(data.edges.length, 3);
  assert.ok(data.edges.some(e => e.kind === 'fallback'));
  assert.throws(() => buildMap(story([{ ...intro, next: 'missing' }])));
});


test('valid IDs matching inherited property names retain numeric visit counts', () => {
  const session = createSession(story([{ id: 'toString', type: 'narration', lines: [{ text: '{{toString}}' }], next: 'end' }, ending]));
  assert.equal(session.start().view.line.text, '');
  assert.equal(session.snapshot().state.visits.toString, 1);
  const before = session.snapshot();
  assert.throws(() => session.dispatch({ type: 'unexpected' }), /Unknown player command/);
  assert.deepEqual(session.snapshot(), before);
});


test('class-based module registration and migration methods retain their receiver', () => {
  class Probe {
    id = 'probe'; version = '1'; stateVersion = 1; initialState = { count: 0 };
    register(registrar) { registrar.command(`${this.id}:mark`, ctx => ctx.setTag('marked', true)); }
    migrateState(data) { return { ...data, module: this.id }; }
  }
  const module = new Probe(), compiled = compileStory(story([intro, ending]), [module]);
  const session = createSession(compiled); session.start();
  session.dispatch({ type: 'module.command', name: 'probe:mark' });
  assert.ok(session.snapshot().state.tags.includes('marked'));
  const old = session.snapshot(); old.moduleVersions.probe = '0';
  session.restore(old);
  assert.equal(session.snapshot().state.modules.probe.data.module, 'probe');
});

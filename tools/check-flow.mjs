import assert from "node:assert/strict";
import { compileStory } from "../packages/content/dist/index.js";
import { createSession } from "../packages/core/dist/index.js";
import { parseSnapshot, serializeSnapshot } from "../packages/save/dist/index.js";

const probe = {
  id: "probe",
  version: "1.0.0",
  register() {}
};

const story = {
  schemaVersion: "1",
  id: "smoke",
  version: "1.0.0",
  title: "Smoke",
  start: "intro",
  variables: { score: { type: "number", default: 0 } },
  nodes: [
    { id: "intro", type: "dialogue", lines: [{ speaker: "guide", text: "Welcome {{score}}" }, { text: "Choose." }], next: "choice" },
    { id: "choice", type: "choice", prompt: "Continue?", options: [{ id: "yes", text: "Yes", next: "go", actions: [{ type: "add", variable: "score", value: 1 }] }] },
    { id: "go", type: "module", module: "probe", input: { mode: "smoke" }, outcomes: { done: "ending" } },
    { id: "ending", type: "end", ending: "done", text: "Score {{score}}" }
  ]
};

const compiled = compileStory(story, [probe]);
const session = createSession(compiled, { seed: 7 });
assert.equal(session.start().view.line.text, "Welcome 0");
session.dispatch({ type: "continue" });
assert.equal(session.dispatch({ type: "continue" }).view.awaiting, "choice");
const waiting = session.dispatch({ type: "choose", optionId: "yes" });
assert.equal(waiting.view.awaiting, "module");
assert.equal(waiting.effects[0].type, "module.request");
const saved = parseSnapshot(serializeSnapshot(session.snapshot()));
const resumed = createSession(compiled, { seed: 999 });
resumed.restore(saved);
const requestId = resumed.getView().pending.id;
const ended = resumed.dispatch({ type: "module.result", requestId, outcome: "done" });
assert.equal(ended.view.awaiting, "ended");
assert.equal(ended.view.ending.text, "Score 1");
const beforeRejected = resumed.snapshot();
assert.throws(() => resumed.dispatch({ type: "module.result", requestId, outcome: "done" }));
assert.deepEqual(resumed.snapshot(), beforeRejected);
console.log("flow check passed");

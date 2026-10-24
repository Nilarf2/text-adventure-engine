export const ENGINE_VERSION = "0.1.0";
export const SCHEMA_VERSION = "1";
export type Scalar = string | number | boolean;
export type JsonValue = null | Scalar | JsonValue[] | { [key: string]: JsonValue };
export type Variables = Record<string, Scalar>;
export type ExtensionName = `${string}:${string}`;

export class EngineError extends Error {
  constructor(public readonly code: string, message: string, public readonly path?: string) {
    super(message);
    this.name = "EngineError";
  }
}

export function assertJson(value: unknown, path = "$", depth = 0): asserts value is JsonValue {
  if (depth > 100) throw new EngineError("JSON_DEPTH", "JSON nesting exceeds 100 levels", path);
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (typeof value !== "object" || value === undefined) throw new EngineError("JSON_VALUE", "Expected a finite JSON value", path);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) assertJson(value[i], `${path}/${i}`, depth + 1);
    return;
  }
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) throw new EngineError("JSON_OBJECT", "Expected a plain JSON object", path);
  for (const [key, child] of Object.entries(value)) {
    if (["__proto__", "prototype", "constructor"].includes(key)) throw new EngineError("JSON_KEY", `Reserved key: ${key}`, path);
    assertJson(child, `${path}/${key}`, depth + 1);
  }
}

export function cloneJson<T>(value: T): T {
  assertJson(value);
  return JSON.parse(JSON.stringify(value)) as T;
}

export type ValueExpression = Scalar | { var: string } | { random: { min: number; max: number } };
export type Condition =
  | { op: "eq" | "ne" | "gt" | "gte" | "lt" | "lte"; left: ValueExpression; right: ValueExpression }
  | { op: "and" | "or"; conditions: Condition[] }
  | { op: "not"; condition: Condition }
  | { op: "tag"; tag: string }
  | { op: "visited"; node: string; count?: number }
  | { op: ExtensionName; data?: JsonValue };

export interface MusicOptions { loop?: boolean; volume?: number; fadeMs?: number }
export interface AudioTrack { asset: string; loop: boolean; volume: number }
export type AudioChannel = "music" | "ambience";
export type Action =
  | { type: "set"; variable: string; value: ValueExpression }
  | { type: "add"; variable: string; value: ValueExpression }
  | { type: "tag.add" | "tag.remove"; tag: string }
  | { type: "emit"; name: string; payload?: JsonValue }
  | { type: "audio.play"; asset: string; channel?: AudioChannel; options?: MusicOptions }
  | { type: "audio.stop"; channel?: AudioChannel; fadeMs?: number }
  | { type: "audio.sfx"; asset: string; volume?: number }
  | { type: "checkpoint"; name?: string }
  | { type: ExtensionName; data?: JsonValue };

export interface NodeBase { id: string; type: string; onEnter?: Action[] }
export interface DialogueLine { text: string; speaker?: string; expression?: string; voice?: string }
export interface DialogueNode extends NodeBase { type: "dialogue" | "narration"; lines: DialogueLine[]; next: string }
export interface ChoiceOption { id: string; text: string; next: string; when?: Condition; disabledWhen?: Condition; disabledReason?: string; actions?: Action[] }
export interface ChoiceNode extends NodeBase { type: "choice"; prompt?: string; options: ChoiceOption[]; fallback?: string }
export interface BranchNode extends NodeBase { type: "branch"; branches: { when: Condition; next: string }[]; fallback: string }
export interface ActionNode extends NodeBase { type: "action"; actions: Action[]; next: string }
export interface SceneNode extends NodeBase { type: "scene"; scene: string; background?: string; music?: string; ambience?: string; next: string }
export interface ModuleNode extends NodeBase { type: "module"; module: string; input?: JsonValue; outcomes: Record<string, string>; resultVariable?: string }
export interface EndNode extends NodeBase { type: "end"; ending: string; text?: string }
export interface CustomNode extends NodeBase { type: ExtensionName; data?: JsonValue; next?: string }
export type StoryNode = DialogueNode | ChoiceNode | BranchNode | ActionNode | SceneNode | ModuleNode | EndNode | CustomNode;
export interface VariableDefinition { type: "string" | "number" | "boolean"; default: Scalar }
export interface AssetDefinition { src: string; type: "image" | "audio" | "other"; version?: string }
export interface CharacterDefinition { name: string; portrait?: string; expressions?: Record<string, string> }
export interface Story {
  schemaVersion: "1";
  id: string;
  version: string;
  title: string;
  start: string;
  locale?: string;
  variables?: Record<string, VariableDefinition>;
  characters?: Record<string, CharacterDefinition>;
  assets?: Record<string, AssetDefinition>;
  nodes: StoryNode[];
}

export interface PendingModuleRequest { id: string; module: string; nodeId: string; input: JsonValue }
export interface ModuleSlice { version: number; data: JsonValue }
export interface SessionState {
  started: boolean;
  revision: number;
  nodeId: string;
  lineIndex: number;
  awaiting: "start" | "continue" | "choice" | "module" | "ended";
  variables: Variables;
  tags: string[];
  visits: Record<string, number>;
  randomState: number;
  requestSequence: number;
  modules: Record<string, ModuleSlice>;
  pending?: PendingModuleRequest;
  scene?: { id: string; background?: string };
  audio: Partial<Record<AudioChannel, AudioTrack>>;
  ending?: string;
  checkpoint?: string;
}
export interface SessionSnapshot {
  formatVersion: 1;
  engineVersion: string;
  schemaVersion: "1";
  gameId: string;
  contentVersion: string;
  moduleVersions: Record<string, string>;
  state: SessionState;
}
export type PlayerCommand =
  | { type: "continue" }
  | { type: "choose"; optionId: string }
  | { type: "module.result"; requestId: string; outcome: string; result?: JsonValue }
  | { type: "module.command"; name: ExtensionName; payload?: JsonValue };
export interface RuntimeEvent { type: string; payload?: JsonValue }
export type RuntimeEffect =
  | { type: "audio.play"; channel: AudioChannel; track: AudioTrack; fadeMs?: number }
  | { type: "audio.stop"; channel: AudioChannel; fadeMs?: number }
  | { type: "audio.sfx"; asset: string; volume?: number }
  | { type: "scene"; scene: string; background?: string }
  | { type: "module.request"; request: PendingModuleRequest }
  | { type: "checkpoint"; name?: string }
  | { type: ExtensionName; payload?: JsonValue };
export interface SessionView {
  nodeId: string;
  awaiting: SessionState["awaiting"];
  line?: DialogueLine;
  prompt?: string;
  choices?: { id: string; text: string; disabled: boolean; disabledReason?: string }[];
  scene?: SessionState["scene"];
  pending?: PendingModuleRequest;
  ending?: { id: string; text?: string };
}
export interface StepResult { state: SessionState; view: SessionView; events: RuntimeEvent[]; effects: RuntimeEffect[] }
export interface SessionOptions { seed?: number; maxAutoSteps?: number; onListenerError?: (error: unknown) => void }
export interface GameSession {
  start(): StepResult;
  dispatch(command: PlayerCommand): StepResult;
  getView(): SessionView;
  snapshot(): SessionSnapshot;
  restore(snapshot: SessionSnapshot): StepResult;
  subscribe(listener: (result: StepResult) => void): () => void;
  dispose(): void;
}

export interface ExecutionContext {
  getVariable(name: string): Scalar;
  setVariable(name: string, value: Scalar): void;
  hasTag(tag: string): boolean;
  setTag(tag: string, present: boolean): void;
  visitCount(nodeId: string): number;
  random(): number;
  getModuleState(moduleId: string): JsonValue;
  setModuleState(moduleId: string, value: JsonValue): void;
  emit(event: RuntimeEvent): void;
  effect(effect: RuntimeEffect): void;
  capability<T = unknown>(name: ExtensionName): T;
}
export type ExtensionValidator = (value: unknown) => string[];
export interface ModuleRegistrar {
  node(name: ExtensionName, handler: (context: ExecutionContext, node: CustomNode) => string, validate?: ExtensionValidator): void;
  condition(name: ExtensionName, handler: (context: ExecutionContext, data?: JsonValue) => boolean, validate?: ExtensionValidator): void;
  action(name: ExtensionName, handler: (context: ExecutionContext, data?: JsonValue) => void, validate?: ExtensionValidator): void;
  command(name: ExtensionName, handler: (context: ExecutionContext, payload?: JsonValue) => void): void;
  capability(name: ExtensionName, value: unknown): void;
}
export interface AdventureModule {
  id: string;
  version: string;
  dependencies?: Record<string, string>;
  stateVersion?: number;
  initialState?: JsonValue;
  migrateState?: (state: JsonValue, from: number, to: number) => JsonValue;
  register(registrar: ModuleRegistrar): void;
}
export interface Registered<T> { owner: string; handler: T; validate?: ExtensionValidator }
export interface ModuleRegistry {
  modules: ReadonlyMap<string, AdventureModule>;
  nodes: ReadonlyMap<string, Registered<(context: ExecutionContext, node: CustomNode) => string>>;
  conditions: ReadonlyMap<string, Registered<(context: ExecutionContext, data?: JsonValue) => boolean>>;
  actions: ReadonlyMap<string, Registered<(context: ExecutionContext, data?: JsonValue) => void>>;
  commands: ReadonlyMap<string, Registered<(context: ExecutionContext, payload?: JsonValue) => void>>;
  capabilities: ReadonlyMap<string, unknown>;
}
export interface CompiledStory { story: Story; nodes: ReadonlyMap<string, StoryNode>; registry: ModuleRegistry }

export function createModuleRegistry(modules: readonly AdventureModule[] = []): ModuleRegistry {
  const byId = new Map<string, AdventureModule>();
  for (const mod of modules) {
    if (typeof mod.id !== "string" || !/^[a-z][a-z0-9-]*$/.test(mod.id) || ["constructor", "prototype", "__proto__"].includes(mod.id) || byId.has(mod.id)) throw new EngineError("MODULE_ID", `Invalid or duplicate module ID: ${mod.id}`);
    if (typeof mod.version !== "string" || !mod.version.trim() || !Number.isSafeInteger(mod.stateVersion ?? 1) || (mod.stateVersion ?? 1) < 1) throw new EngineError("MODULE_VERSION", `Invalid version: ${mod.id}`);
    if (mod.initialState !== undefined) assertJson(mod.initialState);
    byId.set(mod.id, { ...mod, id: mod.id, version: mod.version, stateVersion: mod.stateVersion ?? 1, register: mod.register.bind(mod), ...(mod.migrateState ? { migrateState: mod.migrateState.bind(mod) } : {}), ...(mod.dependencies ? { dependencies: { ...mod.dependencies } } : {}), ...(mod.initialState !== undefined ? { initialState: cloneJson(mod.initialState) } : {}) });
  }
  const ordered: AdventureModule[] = [];
  const visiting = new Set<string>();
  const visited = new Set<string>();
  const visit = (mod: AdventureModule) => {
    if (visiting.has(mod.id)) throw new EngineError("MODULE_CYCLE", `Circular dependency: ${mod.id}`);
    if (visited.has(mod.id)) return;
    visiting.add(mod.id);
    for (const [id, required] of Object.entries(mod.dependencies ?? {})) {
      const dependency = byId.get(id);
      if (!dependency || (required !== "*" && dependency.version !== required)) throw new EngineError("MODULE_DEPENDENCY", `${mod.id} needs ${id}@${required}`);
      visit(dependency);
    }
    visiting.delete(mod.id);
    visited.add(mod.id);
    ordered.push(mod);
  };
  for (const mod of byId.values()) visit(mod);
  const nodes = new Map<string, Registered<(context: ExecutionContext, node: CustomNode) => string>>();
  const conditions = new Map<string, Registered<(context: ExecutionContext, data?: JsonValue) => boolean>>();
  const actions = new Map<string, Registered<(context: ExecutionContext, data?: JsonValue) => void>>();
  const commands = new Map<string, Registered<(context: ExecutionContext, payload?: JsonValue) => void>>();
  const capabilities = new Map<string, unknown>();
  for (const mod of ordered) {
    const add = <T>(map: Map<string, Registered<T>>, name: ExtensionName, handler: T, validate?: ExtensionValidator) => {
      if (!name.startsWith(`${mod.id}:`) || !/^[a-z][a-z0-9-]*:[a-zA-Z0-9_.-]+$/.test(name) || map.has(name)) throw new EngineError("MODULE_REGISTRATION", `Invalid or conflicting registration: ${name}`);
      map.set(name, { owner: mod.id, handler, ...(validate ? { validate } : {}) });
    };
    mod.register({
      node: (name, handler, validate) => add(nodes, name, handler, validate),
      condition: (name, handler, validate) => add(conditions, name, handler, validate),
      action: (name, handler, validate) => add(actions, name, handler, validate),
      command: (name, handler) => add(commands, name, handler),
      capability: (name, value) => {
        if (!name.startsWith(`${mod.id}:`) || !/^[a-z][a-z0-9-]*:[a-zA-Z0-9_.-]+$/.test(name) || capabilities.has(name)) throw new EngineError("MODULE_REGISTRATION", `Invalid or conflicting capability: ${name}`);
        capabilities.set(name, value);
      }
    });
  }
  return { modules: new Map(ordered.map(mod => [mod.id, mod])), nodes, conditions, actions, commands, capabilities };
}

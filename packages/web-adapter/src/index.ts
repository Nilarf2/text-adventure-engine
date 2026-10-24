import {
  AssetDefinition,
  AudioChannel,
  AudioTrack,
  RuntimeEffect,
  SessionSnapshot,
  SessionState,
  Story,
  cloneJson
} from "@text-adventure/module-api";
import { SaveEntry, SaveRecord, SaveStore, validateSnapshot } from "@text-adventure/save";

const SAVE_PREFIX = "text-adventure:save:v1:";

function validateSlotId(slotId: string): void {
  if (typeof slotId !== "string" || slotId.trim().length === 0 || slotId.length > 180) {
    throw new Error("Save slot ID must contain 1 to 180 characters");
  }
}

function parseStoredRecord(value: unknown, expectedSlotId?: string): SaveRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid local save record");
  const record = value as Record<string, unknown>;
  if (typeof record.slotId !== "string" || (expectedSlotId !== undefined && record.slotId !== expectedSlotId)) {
    throw new Error("Local save slot ID does not match its key");
  }
  if (typeof record.savedAt !== "string" || !Number.isFinite(Date.parse(record.savedAt))) throw new Error("Invalid local save timestamp");
  if (record.label !== undefined && typeof record.label !== "string") throw new Error("Invalid local save label");
  validateSnapshot(record.snapshot);
  return record as unknown as SaveRecord;
}

export class LocalStorageSaveStore implements SaveStore {
  private readonly storage: Storage;

  constructor(storage?: Storage, private readonly prefix = SAVE_PREFIX) {
    if (storage) {
      this.storage = storage;
    } else {
      try {
        if (typeof globalThis.localStorage === "undefined") throw new Error("localStorage is unavailable");
        this.storage = globalThis.localStorage;
      } catch (error) {
        throw new Error("Unable to access browser localStorage", { cause: error });
      }
    }
  }

  async list(gameId?: string): Promise<SaveEntry[]> {
    const entries: SaveEntry[] = [];
    for (let index = 0; index < this.storage.length; index++) {
      const key = this.storage.key(index);
      if (!key?.startsWith(this.prefix)) continue;
      let save: SaveRecord;
      try {
        const slotId = decodeURIComponent(key.slice(this.prefix.length));
        validateSlotId(slotId);
        const raw = this.storage.getItem(key);
        if (raw === null) continue;
        save = parseStoredRecord(JSON.parse(raw) as unknown, slotId);
      } catch { continue; } // A corrupt slot must not hide healthy saves. read() still reports it.
      if (gameId !== undefined && save.snapshot.gameId !== gameId) continue;
      entries.push({
        slotId: save.slotId,
        gameId: save.snapshot.gameId,
        contentVersion: save.snapshot.contentVersion,
        savedAt: save.savedAt,
        ...(save.label === undefined ? {} : { label: save.label })
      });
    }
    return entries.sort((a, b) => b.savedAt.localeCompare(a.savedAt));
  }

  async read(slotId: string): Promise<SaveRecord | null> {
    validateSlotId(slotId);
    const raw = this.storage.getItem(this.key(slotId));
    if (raw === null) return null;
    return parseStoredRecord(JSON.parse(raw) as unknown, slotId);
  }

  async write(record: SaveRecord): Promise<void> {
    const valid = parseStoredRecord(cloneJson(record));
    validateSlotId(valid.slotId);
    this.storage.setItem(this.key(valid.slotId), JSON.stringify(valid));
  }

  async delete(slotId: string): Promise<boolean> {
    validateSlotId(slotId);
    const key = this.key(slotId);
    const existed = this.storage.getItem(key) !== null;
    if (existed) this.storage.removeItem(key);
    return existed;
  }

  private key(slotId: string): string {
    return `${this.prefix}${encodeURIComponent(slotId)}`;
  }
}

export interface FadeOptions { fadeMs?: number }
export interface MusicOptions extends FadeOptions { loop?: boolean; volume?: number; channel?: AudioChannel }
export type AssetResolver = (assetId: string, definition?: AssetDefinition) => string | undefined | null | Promise<string | undefined | null>;
export interface AudioFailureContext { operation: string; assetId?: string; channel?: AudioChannel }
export interface AudioAdapterOptions {
  assets?: Story["assets"];
  resolveAsset?: AssetResolver;
  onError?: (error: unknown, context: AudioFailureContext) => void;
  createAudio?: (source: string) => HTMLAudioElement;
  fadeTickMs?: number;
}

export interface AudioPort {
  playMusic(assetId: string, options?: MusicOptions): Promise<void>;
  playAmbience(assetId: string, options?: Omit<MusicOptions, "channel">): Promise<void>;
  playSfx(assetId: string, volume?: number): Promise<void>;
  stopMusic(options?: FadeOptions): Promise<void>;
  stopAmbience(options?: FadeOptions): Promise<void>;
  pause(channel?: AudioChannel): void;
  resume(channel?: AudioChannel): Promise<void>;
  setVolume(channel: AudioChannel, volume: number, fadeMs?: number): Promise<void>;
}

interface TrackHandle {
  assetId: string;
  audio: HTMLAudioElement;
  targetVolume: number;
  shouldPlay: boolean;
  pendingFadeMs: number;
}

interface FadeJob {
  timer: ReturnType<typeof setInterval>;
  settle: () => void;
}

export class WebAudioAdapter implements AudioPort {
  private readonly channels = new Map<AudioChannel, TrackHandle>();
  private readonly generations = new Map<AudioChannel, number>();
  private readonly fades = new Map<AudioChannel, FadeJob>();
  private readonly soundEffects = new Set<HTMLAudioElement>();
  private readonly blockedEffects = new Set<HTMLAudioElement>();
  private disposed = false;
  private readonly createAudio: (source: string) => HTMLAudioElement;

  constructor(private readonly options: AudioAdapterOptions = {}) {
    this.createAudio = options.createAudio ?? (source => {
      const audio = new Audio(source);
      audio.preload = "auto";
      return audio;
    });
  }

  async playMusic(assetId: string, options: MusicOptions = {}): Promise<void> {
    await this.playTrack(assetId, options.channel ?? "music", options);
  }

  async playAmbience(assetId: string, options: Omit<MusicOptions, "channel"> = {}): Promise<void> {
    await this.playTrack(assetId, "ambience", options);
  }

  async playSfx(assetId: string, volume = 1): Promise<void> {
    if (this.disposed) return;
    try {
      const source = await this.resolveAsset(assetId);
      if (this.disposed) return;
      const audio = this.createAudio(source);
      audio.loop = false;
      audio.volume = this.clampVolume(volume);
      this.soundEffects.add(audio);
      audio.onended = () => this.releaseSfx(audio);
      await this.tryPlay(audio, { operation: "playSfx", assetId });
    } catch (error) {
      this.report(error, { operation: "playSfx", assetId });
    }
  }

  async stopMusic(options: FadeOptions = {}): Promise<void> {
    await this.stop("music", options);
  }

  async stopAmbience(options: FadeOptions = {}): Promise<void> {
    await this.stop("ambience", options);
  }

  async stop(channel: AudioChannel, options: FadeOptions = {}): Promise<void> {
    const generation = this.nextGeneration(channel);
    const handle = this.channels.get(channel);
    if (!handle) return;
    await this.fadeTo(channel, handle, 0, options.fadeMs ?? 0, generation);
    if (this.disposed || generation !== this.generation(channel) || this.channels.get(channel) !== handle) return;
    this.channels.delete(channel);
    this.releaseTrack(handle);
  }

  pause(channel: AudioChannel = "music"): void {
    this.nextGeneration(channel);
    const handle = this.channels.get(channel);
    if (!handle) return;
    this.cancelFade(channel);
    handle.shouldPlay = false;
    try {
      handle.audio.pause();
    } catch (error) {
      this.report(error, { operation: "pause", assetId: handle.assetId, channel });
    }
  }

  async resume(channel: AudioChannel = "music"): Promise<void> {
    const handle = this.channels.get(channel);
    if (!handle || this.disposed) return;
    handle.shouldPlay = true;
    const played = await this.tryPlay(handle.audio, { operation: "resume", assetId: handle.assetId, channel });
    if (played && handle.pendingFadeMs > 0) {
      const generation = this.generation(channel);
      const fadeMs = handle.pendingFadeMs;
      handle.pendingFadeMs = 0;
      await this.fadeTo(channel, handle, handle.targetVolume, fadeMs, generation);
    }
  }

  async setVolume(channel: AudioChannel, volume: number, fadeMs = 0): Promise<void> {
    const handle = this.channels.get(channel);
    if (!handle) return;
    const target = this.clampVolume(volume);
    handle.targetVolume = target;
    const generation = this.nextGeneration(channel);
    await this.fadeTo(channel, handle, target, fadeMs, generation);
  }

  async unlock(): Promise<void> {
    if (this.disposed) return;
    for (const [channel, handle] of this.channels) {
      if (!handle.shouldPlay || !handle.audio.paused) continue;
      const played = await this.tryPlay(handle.audio, { operation: "unlock", assetId: handle.assetId, channel });
      if (played && handle.pendingFadeMs > 0) {
        const generation = this.generation(channel);
        const fadeMs = handle.pendingFadeMs;
        handle.pendingFadeMs = 0;
        await this.fadeTo(channel, handle, handle.targetVolume, fadeMs, generation);
      }
    }
    for (const audio of [...this.blockedEffects]) {
      if (this.disposed) break;
      if (!audio.paused) {
        this.blockedEffects.delete(audio);
        continue;
      }
      if (await this.tryPlay(audio, { operation: "unlockSfx" })) this.blockedEffects.delete(audio);
    }
  }

  async handleEffect(effect: RuntimeEffect): Promise<void> {
    if (this.disposed) return;
    try {
      switch (effect.type) {
        case "audio.play":
          await this.playTrack(effect.track.asset, effect.channel, {
            loop: effect.track.loop,
            volume: effect.track.volume,
            fadeMs: effect.fadeMs
          });
          break;
        case "audio.stop":
          await this.stop(effect.channel ?? "music", { fadeMs: effect.fadeMs });
          break;
        case "audio.sfx":
          await this.playSfx(effect.asset, effect.volume);
          break;
      }
    } catch (error) {
      this.report(error, { operation: `effect:${effect.type}` });
    }
  }

  async reconcile(snapshot: SessionSnapshot | SessionState): Promise<void> {
    const state = "state" in snapshot ? snapshot.state : snapshot;
    for (const channel of ["music", "ambience"] as const) {
      const track = state.audio[channel];
      if (track) {
        await this.playTrack(track.asset, channel, { loop: track.loop, volume: track.volume });
      } else {
        await this.stop(channel);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const channel of ["music", "ambience"] as const) {
      this.nextGeneration(channel);
      const handle = this.channels.get(channel);
      if (handle) this.releaseTrack(handle);
    }
    this.channels.clear();
    for (const audio of this.soundEffects) this.releaseSfx(audio);
    this.blockedEffects.clear();
  }

  private async playTrack(assetId: string, channel: AudioChannel, options: MusicOptions): Promise<void> {
    if (this.disposed) return;
    const generation = this.nextGeneration(channel);
    const targetVolume = this.clampVolume(options.volume ?? 1);
    const fadeMs = this.clampDuration(options.fadeMs ?? 0);
    try {
      const source = await this.resolveAsset(assetId);
      if (this.disposed || generation !== this.generation(channel)) return;
      const existing = this.channels.get(channel);
      if (existing?.assetId === assetId) {
        existing.audio.loop = options.loop ?? true;
        existing.targetVolume = targetVolume;
        existing.shouldPlay = true;
        existing.pendingFadeMs = fadeMs;
        const played = await this.tryPlay(existing.audio, { operation: "playMusic", assetId, channel });
        if (this.disposed || generation !== this.generation(channel) || this.channels.get(channel) !== existing) return;
        if (played) {
          existing.pendingFadeMs = 0;
          await this.fadeTo(channel, existing, targetVolume, fadeMs, generation);
        }
        return;
      }
      if (existing) {
        await this.fadeTo(channel, existing, 0, fadeMs, generation);
        if (this.disposed || generation !== this.generation(channel) || this.channels.get(channel) !== existing) return;
        this.channels.delete(channel);
        this.releaseTrack(existing);
      }
      const audio = this.createAudio(source);
      audio.loop = options.loop ?? true;
      audio.volume = fadeMs > 0 ? 0 : targetVolume;
      const handle: TrackHandle = { assetId, audio, targetVolume, shouldPlay: true, pendingFadeMs: fadeMs };
      this.channels.set(channel, handle);
      const played = await this.tryPlay(audio, { operation: "playMusic", assetId, channel });
      if (this.disposed || generation !== this.generation(channel) || this.channels.get(channel) !== handle) return;
      if (played) {
        handle.pendingFadeMs = 0;
        if (fadeMs > 0) await this.fadeTo(channel, handle, targetVolume, fadeMs, generation);
      }
    } catch (error) {
      this.report(error, { operation: "playMusic", assetId, channel });
    }
  }

  private async resolveAsset(assetId: string): Promise<string> {
    const definition = this.options.assets?.[assetId];
    if (definition && definition.type !== "audio") throw new Error(`Asset ${assetId} is not an audio asset`);
    const source = this.options.resolveAsset
      ? await this.options.resolveAsset(assetId, definition)
      : definition?.src;
    if (!source) throw new Error(`Audio asset is not defined: ${assetId}`);
    return source;
  }

  private async tryPlay(audio: HTMLAudioElement, context: AudioFailureContext): Promise<boolean> {
    try {
      await audio.play();
      if (this.disposed || ((context.channel !== undefined) && (this.channels.get(context.channel)?.audio !== audio || !this.channels.get(context.channel)?.shouldPlay))) {
        audio.pause();
        return false;
      }
      this.blockedEffects.delete(audio);
      return true;
    } catch (error) {
      if (this.disposed) { audio.pause(); return false; }
      if (context.operation === "playSfx" || context.operation === "unlockSfx") {
        if (error instanceof Error && error.name === "NotAllowedError") this.blockedEffects.add(audio);
        else this.releaseSfx(audio);
      }
      this.report(error, context);
      return false;
    }
  }

  private fadeTo(channel: AudioChannel, handle: TrackHandle, target: number, duration: number, generation: number): Promise<void> {
    this.cancelFade(channel);
    if (duration <= 0 || this.disposed) {
      handle.audio.volume = target;
      return Promise.resolve();
    }
    const start = handle.audio.volume;
    const began = Date.now();
    const tickMs = Math.max(10, this.options.fadeTickMs ?? 25);
    return new Promise(resolve => {
      const settle = () => {
        const job = this.fades.get(channel);
        if (job?.timer === timer) this.fades.delete(channel);
        clearInterval(timer);
        resolve();
      };
      const timer = setInterval(() => {
        if (this.disposed || this.generation(channel) !== generation || this.channels.get(channel) !== handle) {
          settle();
          return;
        }
        const progress = Math.min(1, (Date.now() - began) / duration);
        handle.audio.volume = start + ((target - start) * progress);
        if (progress >= 1) settle();
      }, tickMs);
      this.fades.set(channel, { timer, settle });
    });
  }

  private nextGeneration(channel: AudioChannel): number {
    this.cancelFade(channel);
    const generation = this.generation(channel) + 1;
    this.generations.set(channel, generation);
    return generation;
  }

  private generation(channel: AudioChannel): number {
    return this.generations.get(channel) ?? 0;
  }

  private cancelFade(channel: AudioChannel): void {
    this.fades.get(channel)?.settle();
  }

  private releaseTrack(handle: TrackHandle): void {
    try {
      handle.shouldPlay = false;
      handle.audio.pause();
      handle.audio.onended = null;
      handle.audio.removeAttribute("src");
      handle.audio.load();
    } catch (error) {
      this.report(error, { operation: "release", assetId: handle.assetId });
    }
  }

  private releaseSfx(audio: HTMLAudioElement): void {
    this.soundEffects.delete(audio);
    this.blockedEffects.delete(audio);
    audio.onended = null;
    try {
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
    } catch (error) {
      this.report(error, { operation: "releaseSfx" });
    }
  }

  private clampVolume(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 1;
  }

  private clampDuration(value: number): number {
    return Number.isFinite(value) ? Math.max(0, value) : 0;
  }

  private report(error: unknown, context: AudioFailureContext): void {
    try {
      this.options.onError?.(error, context);
    } catch {
      // Error reporting must not interrupt playback cleanup.
    }
  }
}

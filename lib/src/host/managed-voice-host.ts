/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Managed voice"):
 * holds the token the Burrow service's sign-in hands it, adds it and the voice
 * id to the webview's text, caches the clips, and answers with audio or a
 * diagnostic failure. Where the request may go:
 * `docs/specs/security-local.md` -> "Persisted state".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isManagedVoiceId, isManagedVoiceToken } from 'remote-lib-common';
import { writeJsonAtomic } from './atomic-json-file';
import { hostedVoiceOrigin, type RelayBuild } from './relay-origin';
import { createSerialQueue } from './remote/serial-queue';
import {
  DEFAULT_MANAGED_VOICE_ID,
  type ManagedVoiceConfigResult,
  type ManagedVoiceHostSpeakResult,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

export const MANAGED_VOICE_FILE = 'managed-voice.json';
const MANAGED_VOICE_SPEAK_PATH = '/api/voice/speak';
/** `docs/specs/alert.md` -> "Managed voice"; Rust's `MANAGED_VOICE_TIMEOUT` sits above it. */
const MANAGED_VOICE_REQUEST_TIMEOUT_MS = 15_000;
/** Hosted's own bound on `text`. */
const MAX_TEXT_LENGTH = 200;
/** `docs/specs/standalone.md` -> "Rust ↔ sidecar bridge". */
export const MAX_AUDIO_BYTES = 512 * 1024;
/** The clip cache's bounds: an alarm label repeats, so a few dozen clips cover a day. */
export const CLIP_CACHE_MAX_ENTRIES = 32;
export const CLIP_CACHE_MAX_BYTES = 4 * 1024 * 1024;

interface StoredConfig {
  token: string | null;
  voiceId: string;
}

function normalizeStored(value: unknown): StoredConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  return {
    token: isManagedVoiceToken(record.token) ? record.token : null,
    // A voice the curated set no longer holds reads as the default, which speak can send.
    voiceId: isManagedVoiceId(record.voiceId) ? record.voiceId : DEFAULT_MANAGED_VOICE_ID,
  };
}

/**
 * The Burrow service's side of the token: sign-in saves it, sign-out clears it
 * (`docs/specs/hosted.md` -> "Managed voice"). **In-process only**: no webview
 * command reaches it, so the token never enters a webview realm.
 */
export interface ManagedVoiceCredential {
  save(token: string): Promise<void>;
  clear(): Promise<void>;
}

/**
 * Clips by voice and text, least recently used evicted first, bounded in count
 * and bytes. Memory only: never persisted.
 */
function createClipCache() {
  const clips = new Map<string, string>();
  let bytes = 0;
  const sizeOf = (base64: string) => Buffer.byteLength(base64, 'base64');
  const keyOf = (voiceId: string, text: string) => `${voiceId}\n${text}`;
  return {
    get(voiceId: string, text: string): string | undefined {
      const key = keyOf(voiceId, text);
      const clip = clips.get(key);
      if (clip === undefined) return undefined;
      clips.delete(key);
      clips.set(key, clip);
      return clip;
    },
    set(voiceId: string, text: string, clip: string): void {
      const key = keyOf(voiceId, text);
      const old = clips.get(key);
      if (old !== undefined) {
        clips.delete(key);
        bytes -= sizeOf(old);
      }
      clips.set(key, clip);
      bytes += sizeOf(clip);
      for (const [oldest, evicted] of clips) {
        if (clips.size <= CLIP_CACHE_MAX_ENTRIES && bytes <= CLIP_CACHE_MAX_BYTES) break;
        clips.delete(oldest);
        bytes -= sizeOf(evicted);
      }
    },
    clear(): void {
      clips.clear();
      bytes = 0;
    },
  };
}

export function createManagedVoiceHost(options: {
  /** The owner-only state directory; without one no token can be stored. */
  stateDir?: string;
  /** Each change's status, for every window; never the token. */
  onStatus: (status: ManagedVoiceStatus) => void;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** This build's `bakedRelay()`; see `speakUrl`. */
  relay: RelayBuild;
  /**
   * Whether the network policy lets this process reach Hosted
   * (`docs/specs/remote-network.md` → "Policy"), asked at every speak.
   * `false` refuses before any request, a cached clip included.
   */
  networkAllowed: () => Promise<boolean>;
}): { handle(command: unknown): Promise<unknown>; credential: ManagedVoiceCredential } {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MANAGED_VOICE_REQUEST_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const store = options.stateDir
    ? { dir: options.stateDir, file: join(options.stateDir, MANAGED_VOICE_FILE) }
    : undefined;
  // The only place the token may go (`docs/specs/security-local.md` -> "Persisted state"),
  // and `null` in a self-host build: no token is read, nothing is sent, and
  // every edit and speak is refused.
  const voice = hostedVoiceOrigin(options.relay);
  const speakUrl = voice === null ? null : voice + MANAGED_VOICE_SPEAK_PATH;
  let loaded: Promise<StoredConfig> | null = null;
  // Each edit reads, then rewrites the whole file: two at once would drop a field.
  const serialize = createSerialQueue();
  const clips = createClipCache();
  let notEntitled = false;
  /** Bumped by every token change, so a request that outlived its token caches nothing. */
  let tokenGeneration = 0;

  const load = (): Promise<StoredConfig> => {
    loaded ??= (async () => {
      if (!store) return normalizeStored(null);
      try {
        return normalizeStored(JSON.parse(await readFile(store.file, 'utf8')));
      } catch (error) {
        // Only a missing or unparsable file is "no config": a transient lock
        // (EBUSY, EPERM, EMFILE) cached as defaults would let the next edit
        // overwrite the saved token. Anything else is retried on the next read.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
          return normalizeStored(null);
        }
        loaded = null;
        throw error;
      }
    })();
    return loaded;
  };

  const status = (config: StoredConfig): ManagedVoiceStatus =>
    ({ configured: config.token !== null, voiceId: config.voiceId, notEntitled });

  /** Rewrite the file with `edit` applied, then announce the result. Runs on `serialize`. */
  async function save(edit: (config: StoredConfig) => StoredConfig): Promise<ManagedVoiceStatus> {
    if (!store) throw new Error('no owner-only state directory');
    const next = edit({ ...await load() });
    await writeJsonAtomic(store.dir, store.file, next);
    loaded = Promise.resolve(next);
    options.onStatus(status(next));
    return status(next);
  }

  async function configure(update: unknown): Promise<ManagedVoiceConfigResult> {
    if (!store) return { ok: false, reason: 'unavailable' };
    const voiceId = (update as { voiceId?: unknown } | null)?.voiceId;
    if (!isManagedVoiceId(voiceId)) return { ok: false, reason: 'invalid-voice' };
    try {
      return { ok: true, ...await save((config) => ({ ...config, voiceId })) };
    } catch (error) {
      log(`[managed-voice] could not read or save: ${String(error)}`);
      return { ok: false, reason: 'unavailable' };
    }
  }

  /** A changed token forgets every clip and every refusal the old one earned. */
  const setToken = (token: string | null) => serialize(async () => {
    if (speakUrl === null) throw new Error('this build has no managed voice');
    tokenGeneration++;
    clips.clear();
    notEntitled = false;
    await save((config) => ({ ...config, token }));
  });

  /** Latch what Hosted last said of the entitlement, announcing a change. */
  async function noteEntitled(entitled: boolean): Promise<void> {
    if (notEntitled === !entitled) return;
    notEntitled = !entitled;
    const config = await load().catch(() => null);
    if (config) options.onStatus(status(config));
  }

  async function request(speakUrl: string, text: string): Promise<ManagedVoiceHostSpeakResult> {
    const config = await load().catch(() => null);
    if (!config) return { ok: false, reason: 'config unreadable' };
    if (!config.token) return { ok: false, reason: 'unconfigured' };
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'bad-request' };
    // A hit makes no request. Skipped while Hosted says the plan lapsed, so a
    // lapsed member hears the system voice and the next request can learn
    // the plan is back.
    const generation = tokenGeneration;
    const cached = notEntitled ? undefined : clips.get(config.voiceId, trimmed);
    if (cached !== undefined) return { ok: true, audioBase64: cached };

    const signal = AbortSignal.timeout(timeoutMs);
    try {
      const response = await fetchImpl(speakUrl, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${config.token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({ text: trimmed, voiceId: config.voiceId }),
        // Never replay the bearer token to wherever a redirect points.
        redirect: 'error',
        signal,
      });
      const declared = Number(response.headers.get('content-length'));
      const mime = response.headers.get('content-type')?.split(';')[0].trim();
      if (!response.ok || mime !== 'audio/mpeg' || declared > MAX_AUDIO_BYTES) {
        // Hosted's `{ message }` body is never needed.
        await response.body?.cancel().catch(() => {});
        if (response.status === 403) await noteEntitled(false);
        return { ok: false, reason: response.ok ? `unexpected ${mime ?? 'body'}` : `HTTP ${response.status}` };
      }
      const reader = response.body?.getReader();
      if (!reader) return { ok: false, reason: 'audio has no body' };
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AUDIO_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: `audio over ${MAX_AUDIO_BYTES} bytes` };
        }
        chunks.push(value);
      }
      if (size === 0) return { ok: false, reason: 'empty audio' };
      const audioBase64 = Buffer.concat(chunks, size).toString('base64');
      await noteEntitled(true);
      // Only for the token that asked: a sign-out meanwhile cleared the cache.
      if (generation === tokenGeneration) clips.set(config.voiceId, trimmed, audioBase64);
      return { ok: true, audioBase64 };
    } catch {
      return { ok: false, reason: signal.aborted ? 'timeout' : 'network' };
    }
  }

  async function speak(speakUrl: string, text: string): Promise<ManagedVoiceHostSpeakResult> {
    // Expected, like `unconfigured`, so not logged: the renderer falls back.
    if (!(await options.networkAllowed())) return { ok: false, reason: 'network-off' };
    const result = await request(speakUrl, text);
    if (!result.ok && result.reason !== 'unconfigured') log(`[managed-voice] speak failed: ${result.reason}`);
    return result;
  }

  return {
    credential: {
      async save(token) {
        if (!isManagedVoiceToken(token)) throw new Error('not a voice token');
        await setToken(token);
      },
      clear: () => setToken(null),
    },
    async handle(command) {
      const message = (command ?? {}) as Record<string, unknown>;
      switch (message.op) {
        case 'status': return status(speakUrl === null ? normalizeStored(null) : await load());
        case 'configure':
          return speakUrl === null
            ? { ok: false, reason: 'unavailable' } satisfies ManagedVoiceConfigResult
            : serialize(() => configure(message.update));
        case 'speak':
          if (speakUrl === null) return { ok: false, reason: 'self-host' } satisfies ManagedVoiceHostSpeakResult;
          return typeof message.text === 'string'
            ? speak(speakUrl, message.text)
            : { ok: false, reason: 'bad-request' };
        default: return undefined;
      }
    },
  };
}

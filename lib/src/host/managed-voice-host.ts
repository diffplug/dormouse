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

export interface StoredManagedVoice {
  token: string | null;
  voiceId: string;
}

/**
 * Where a host keeps managed voice's config: the sidecar's owner-only file
 * ({@link fileManagedVoiceStore}), or VS Code's `SecretStorage`.
 */
export interface ManagedVoiceStore {
  /**
   * The stored record, unvalidated, or `null` where nothing readable is
   * stored. **Rejects on a transient failure**, which is never "no config": a
   * lock cached as defaults would let the next edit overwrite the token.
   */
  read(): Promise<unknown>;
  /** Persist `next`, of which only `changed` differs from what was read. */
  write(next: StoredManagedVoice, changed: keyof StoredManagedVoice): Promise<void>;
}

/** The sidecar's store: `managed-voice.json` in the owner-only state directory, rewritten whole. */
export function fileManagedVoiceStore(stateDir: string): ManagedVoiceStore {
  const file = join(stateDir, MANAGED_VOICE_FILE);
  return {
    async read() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch (error) {
        // Only a missing or unparsable file is "no config": a transient lock
        // (EBUSY, EPERM, EMFILE) is retried on the next read.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
        throw error;
      }
    },
    write: (next) => writeJsonAtomic(stateDir, file, next),
  };
}

function normalizeStored(value: unknown): StoredManagedVoice {
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
  /** Where the config lives; without one no token can be stored. */
  store?: ManagedVoiceStore;
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
}): {
  handle(command: unknown): Promise<unknown>;
  /** What sign-in saves through; absent in a self-host build, which holds no token. */
  credential: ManagedVoiceCredential | undefined;
  /**
   * Another process may have changed the store (a sibling VS Code window):
   * read it again, and announce what changed. A changed token forgets the
   * clips and the refusal the old one earned; this window's own write, heard
   * back, changes nothing.
   */
  invalidate(): void;
} {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MANAGED_VOICE_REQUEST_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const store = options.store;
  // The only place the token may go (`docs/specs/security-local.md` -> "Persisted state"),
  // and `null` in a self-host build: no token is read, nothing is sent, and
  // every edit and speak is refused.
  const voice = hostedVoiceOrigin(options.relay);
  const speakUrl = voice === null ? null : voice + MANAGED_VOICE_SPEAK_PATH;
  let loaded: Promise<StoredManagedVoice> | null = null;
  // Each edit reads, then rewrites the whole file: two at once would drop a field.
  const serialize = createSerialQueue();
  const clips = createClipCache();
  let notEntitled = false;
  /** Bumped by every token change, so a request that outlived its token caches nothing. */
  let tokenGeneration = 0;

  const load = (): Promise<StoredManagedVoice> => {
    loaded ??= (store ? store.read() : Promise.resolve(null)).then(normalizeStored, (error: unknown) => {
      // Never cached: the next read tries again.
      loaded = null;
      throw error;
    });
    return loaded;
  };

  /** A changed token forgets every clip and every refusal the old one earned. */
  const forgetToken = (): void => {
    tokenGeneration++;
    clips.clear();
    notEntitled = false;
  };

  const status = (config: StoredManagedVoice): ManagedVoiceStatus =>
    ({ configured: config.token !== null, voiceId: config.voiceId, notEntitled });

  /** Store `changed` as `value`, then announce the result. Runs on `serialize`. */
  async function save<K extends keyof StoredManagedVoice>(changed: K, value: StoredManagedVoice[K]): Promise<ManagedVoiceStatus> {
    if (!store) throw new Error('no owner-only store');
    const next = { ...await load(), [changed]: value };
    await store.write(next, changed);
    loaded = Promise.resolve(next);
    options.onStatus(status(next));
    return status(next);
  }

  async function configure(update: unknown): Promise<ManagedVoiceConfigResult> {
    if (!store) return { ok: false, reason: 'unavailable' };
    const voiceId = (update as { voiceId?: unknown } | null)?.voiceId;
    if (!isManagedVoiceId(voiceId)) return { ok: false, reason: 'invalid-voice' };
    try {
      return { ok: true, ...await save('voiceId', voiceId) };
    } catch (error) {
      log(`[managed-voice] could not read or save: ${String(error)}`);
      return { ok: false, reason: 'unavailable' };
    }
  }

  const setToken = (token: string | null) => serialize(async () => {
    if (speakUrl === null) throw new Error('this build has no managed voice');
    forgetToken();
    await save('token', token);
  });

  /** Latch what Hosted last said of the entitlement, announcing a change. */
  async function noteEntitled(entitled: boolean): Promise<void> {
    if (notEntitled === !entitled) return;
    notEntitled = !entitled;
    const config = await load().catch(() => null);
    if (config) options.onStatus(status(config));
  }

  async function request(speakUrl: string, text: string): Promise<ManagedVoiceHostSpeakResult> {
    // Before the read: a token change while it is out must not let this
    // request's answer cache a clip or latch a refusal against the new token.
    const generation = tokenGeneration;
    const config = await load().catch(() => null);
    if (!config) return { ok: false, reason: 'config unreadable' };
    if (!config.token) return { ok: false, reason: 'unconfigured' };
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'bad-request' };
    // A hit makes no request. Skipped while Hosted says the plan lapsed, so a
    // lapsed member hears the system voice and the next request can learn
    // the plan is back.
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
        if (generation === tokenGeneration) {
          if (response.status === 403) await noteEntitled(false);
          // Revoked or unknown — the computer removed at the account page:
          // forgotten, so Settings asks for a fresh sign-in.
          if (response.status === 401) await setToken(null).catch(() => {});
        }
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
      // Only for the token that asked: a sign-out meanwhile cleared the cache.
      if (generation === tokenGeneration) {
        await noteEntitled(true);
        clips.set(config.voiceId, trimmed, audioBase64);
      }
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
    invalidate() {
      if (speakUrl === null) return;
      const before = loaded;
      loaded = null;
      void Promise.all([before?.catch(() => null) ?? null, load()]).then(([previous, next]) => {
        if (previous?.token === next.token && previous.voiceId === next.voiceId) return;
        if (previous?.token !== next.token) forgetToken();
        options.onStatus(status(next));
      }, () => {});
    },
    credential: speakUrl === null ? undefined : {
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

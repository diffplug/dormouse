/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Managed voice"):
 * holds the token, adds it and the voice id to the webview's text, and answers
 * with audio or a diagnostic failure. Where the request may go:
 * `docs/specs/security-local.md` -> "Persisted state".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
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
/** Hosted's own `voiceId` grammar. */
const MANAGED_VOICE_ID_PATTERN = /^[A-Za-z0-9]{1,64}$/;
/** `dmv_` + base64url of 32 random bytes, unpadded. */
const MANAGED_VOICE_TOKEN_PATTERN = /^dmv_[A-Za-z0-9_-]{43}$/;
/** Hosted's own bound on `text`. */
const MAX_TEXT_LENGTH = 200;
/** `docs/specs/standalone.md` -> "Rust ↔ sidecar bridge". */
export const MAX_AUDIO_BYTES = 512 * 1024;

interface StoredConfig {
  token: string | null;
  voiceId: string;
}

function normalizeStored(value: unknown): StoredConfig {
  const record = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const token = typeof record.token === 'string' && MANAGED_VOICE_TOKEN_PATTERN.test(record.token)
    ? record.token : null;
  const voiceId = typeof record.voiceId === 'string' && MANAGED_VOICE_ID_PATTERN.test(record.voiceId)
    ? record.voiceId : DEFAULT_MANAGED_VOICE_ID;
  return { token, voiceId };
}

export function createManagedVoiceHost(options: {
  /** The owner-only state directory; without one no token can be stored. */
  stateDir?: string;
  /** Each saved change's status, for every window; never the token. */
  onStatus: (status: ManagedVoiceStatus) => void;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  log?: (message: string) => void;
  /** This build's `bakedRelay()`; see `speakUrl`. */
  relay: RelayBuild;
  /**
   * Whether the network policy lets this process reach Hosted
   * (`docs/specs/remote-network.md` → "Policy"), asked at every speak.
   * `false` refuses before any request.
   */
  networkAllowed: () => Promise<boolean>;
}): { handle(command: unknown): Promise<unknown> } {
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
    ({ configured: config.token !== null, voiceId: config.voiceId });

  async function configure(update: unknown): Promise<ManagedVoiceConfigResult> {
    if (!store) return { ok: false, reason: 'unavailable' };
    const edit = update && typeof update === 'object' ? update as Record<string, unknown> : {};
    let next: StoredConfig;
    try {
      next = { ...await load() };
      if ('token' in edit) {
        if (edit.token === null) next.token = null;
        else if (typeof edit.token === 'string' && MANAGED_VOICE_TOKEN_PATTERN.test(edit.token.trim())) {
          next.token = edit.token.trim();
        } else return { ok: false, reason: 'invalid-token' };
      }
      if ('voiceId' in edit) {
        if (typeof edit.voiceId !== 'string' || !MANAGED_VOICE_ID_PATTERN.test(edit.voiceId.trim())) {
          return { ok: false, reason: 'invalid-voice' };
        }
        next.voiceId = edit.voiceId.trim();
      }
      await writeJsonAtomic(store.dir, store.file, next);
    } catch (error) {
      log(`[managed-voice] could not read or save: ${String(error)}`);
      return { ok: false, reason: 'unavailable' };
    }
    loaded = Promise.resolve(next);
    options.onStatus(status(next));
    return { ok: true, ...status(next) };
  }

  async function request(speakUrl: string, text: string): Promise<ManagedVoiceHostSpeakResult> {
    const config = await load().catch(() => null);
    if (!config) return { ok: false, reason: 'config unreadable' };
    if (!config.token) return { ok: false, reason: 'unconfigured' };
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'bad-request' };

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
      return { ok: true, audioBase64: Buffer.concat(chunks, size).toString('base64') };
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

/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Managed voice"):
 * holds the token, adds it and the voice id to the webview's text, and answers
 * with audio or a diagnostic failure. Where the request may go:
 * `docs/specs/security-local.md` -> "Persisted state".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file';
import {
  DEFAULT_MANAGED_VOICE_ID,
  MANAGED_VOICE_ID_PATTERN,
  MANAGED_VOICE_ORIGIN,
  MANAGED_VOICE_REQUEST_TIMEOUT_MS,
  MANAGED_VOICE_SPEAK_PATH,
  MANAGED_VOICE_TOKEN_PATTERN,
  type ManagedVoiceConfigResult,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

export { MANAGED_VOICE_REQUEST_TIMEOUT_MS };
export const MANAGED_VOICE_FILE = 'managed-voice.json';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);
/** Hosted's own bound on `text`. */
const MAX_TEXT_LENGTH = 200;
/** A 200-character clip at 128 kbps is far below this; the cap keeps one
 *  base64 line from hogging the PTY stdio pipe. */
export const MAX_AUDIO_BYTES = 512 * 1024;

/** Production's speak URL unless `override` is a bare `http:` loopback origin;
 *  anything else is ignored, never an error. */
export function resolveManagedVoiceSpeakUrl(override: string | undefined): string {
  const production = MANAGED_VOICE_ORIGIN + MANAGED_VOICE_SPEAK_PATH;
  if (!override) return production;
  let url: URL;
  try { url = new URL(override); } catch { return production; }
  const bare = url.username === '' && url.password === '' && url.pathname === '/'
    && url.search === '' && url.hash === '';
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname) || !bare) return production;
  return url.origin + MANAGED_VOICE_SPEAK_PATH;
}

/** One `voice:result`: audio (always `audio/mpeg`) travels as base64 on the JSON-lines pipe. */
export type ManagedVoiceHostSpeakResult =
  | { ok: true; audioBase64: string }
  | { ok: false; reason: string };

export type ManagedVoiceCommand =
  | { op: 'status' }
  | { op: 'configure'; update?: unknown }
  | { op: 'speak'; speakId?: unknown; text?: unknown }
  | { op: 'cancel'; speakId?: unknown };

interface StoredConfig {
  token: string | null;
  voiceId: string;
}

export interface ManagedVoiceHost {
  handle(command: unknown): Promise<ManagedVoiceStatus | ManagedVoiceConfigResult | ManagedVoiceHostSpeakResult | { ok: true } | undefined>;
  /** Abort every in-flight request (sidecar shutdown). */
  dispose(): void;
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
  /** Dev override for Hosted's origin, filtered by `resolveManagedVoiceSpeakUrl`. */
  speakOrigin?: string;
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  log?: (message: string) => void;
}): ManagedVoiceHost {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MANAGED_VOICE_REQUEST_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const store = options.stateDir
    ? { dir: options.stateDir, file: join(options.stateDir, MANAGED_VOICE_FILE) }
    : undefined;
  const speakUrl = resolveManagedVoiceSpeakUrl(options.speakOrigin);
  if (options.speakOrigin) {
    log(speakUrl.startsWith(MANAGED_VOICE_ORIGIN)
      ? '[managed-voice] ignoring DORMOUSE_HOSTED_ORIGIN: not an http loopback origin'
      : `[managed-voice] dev override: speaking via ${speakUrl}`);
  }
  const inFlight = new Map<string, AbortController>();
  let loaded: Promise<StoredConfig> | null = null;

  const load = (): Promise<StoredConfig> => {
    loaded ??= (async () => {
      if (!store) return normalizeStored(null);
      try {
        return normalizeStored(JSON.parse(await readFile(store.file, 'utf8')));
      } catch {
        return normalizeStored(null);
      }
    })();
    return loaded;
  };

  const status = (config: StoredConfig): ManagedVoiceStatus =>
    ({ configured: config.token !== null, voiceId: config.voiceId });

  async function configure(update: unknown): Promise<ManagedVoiceConfigResult> {
    if (!store) return { ok: false, reason: 'unavailable' };
    const edit = update && typeof update === 'object' ? update as Record<string, unknown> : {};
    const next = { ...await load() };
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
    loaded = Promise.resolve(next);
    return { ok: true, ...status(next) };
  }

  async function request(speakId: string, text: string): Promise<ManagedVoiceHostSpeakResult> {
    const config = await load();
    if (!config.token) return { ok: false, reason: 'unconfigured' };
    const trimmed = text.trim();
    if (trimmed.length === 0 || trimmed.length > MAX_TEXT_LENGTH) return { ok: false, reason: 'bad-request' };

    // A cancel that arrived first left a tombstone under this id; it must win.
    if (inFlight.has(speakId)) {
      inFlight.delete(speakId);
      return { ok: false, reason: 'cancelled' };
    }
    const controller = new AbortController();
    inFlight.set(speakId, controller);
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
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
      const chunks: Buffer[] = [];
      let size = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_AUDIO_BYTES) {
          await reader.cancel().catch(() => {});
          return { ok: false, reason: `audio over ${MAX_AUDIO_BYTES} bytes` };
        }
        chunks.push(Buffer.from(value));
      }
      if (size === 0) return { ok: false, reason: 'empty audio' };
      const bytes = Buffer.concat(chunks, size);
      return { ok: true, audioBase64: bytes.toString('base64') };
    } catch {
      if ((signal.reason as Error | undefined)?.name === 'TimeoutError') return { ok: false, reason: 'timeout' };
      if (controller.signal.aborted) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: 'network' };
    } finally {
      if (inFlight.get(speakId) === controller) inFlight.delete(speakId);
    }
  }

  async function speak(speakId: string, text: string): Promise<ManagedVoiceHostSpeakResult> {
    const result = await request(speakId, text);
    if (!result.ok && result.reason !== 'cancelled') log(`[managed-voice] speak failed: ${result.reason}`);
    return result;
  }

  function cancel(speakId: string): void {
    const controller = inFlight.get(speakId);
    if (controller) { controller.abort(); return; }
    // The cancel overtook its speak: leave an aborted tombstone for it to find,
    // swept after the request timeout in case the speak never arrives.
    const tombstone = new AbortController();
    tombstone.abort();
    inFlight.set(speakId, tombstone);
    setTimeout(() => { if (inFlight.get(speakId) === tombstone) inFlight.delete(speakId); }, timeoutMs).unref?.();
  }

  return {
    async handle(command) {
      const message = command as ManagedVoiceCommand | null;
      if (!message || typeof message.op !== 'string') return undefined;
      switch (message.op) {
        case 'status': return status(await load());
        case 'configure': return configure(message.update);
        case 'speak':
          if (typeof message.speakId !== 'string' || typeof message.text !== 'string') {
            return { ok: false, reason: 'bad-request' };
          }
          return speak(message.speakId, message.text);
        case 'cancel':
          if (typeof message.speakId === 'string') cancel(message.speakId);
          return { ok: true };
        default:
          return undefined;
      }
    },
    dispose() {
      for (const controller of inFlight.values()) controller.abort();
      inFlight.clear();
    },
  };
}

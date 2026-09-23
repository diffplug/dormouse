/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Spoken alarms").
 * Runs in the process that may hold a credential — standalone's Node sidecar —
 * so the pasted voice token never reaches a renderer: the webview sends the
 * spoken text, this module adds the token and voice id, calls Hosted, and
 * answers with audio bytes or a failure kind.
 *
 * The only network call is `POST MANAGED_VOICE_SPEAK_URL` (or a loopback dev
 * override, `resolveManagedVoiceSpeakUrl`): outbound, never a listener.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { writeJsonAtomic } from './atomic-json-file';
import {
  DEFAULT_MANAGED_VOICE_ID,
  MANAGED_VOICE_ID_PATTERN,
  MANAGED_VOICE_SPEAK_URL,
  MANAGED_VOICE_TOKEN_PATTERN,
  type ManagedVoiceConfigResult,
  type ManagedVoiceFailure,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

export const MANAGED_VOICE_FILE = 'managed-voice.json';
/** Dev-only: point the speak request at a local `pnpm dev:hosted`. */
export const HOSTED_ORIGIN_ENV = 'DORMOUSE_HOSTED_ORIGIN';
const LOOPBACK_HOSTNAMES = new Set(['127.0.0.1', '[::1]', 'localhost']);

/**
 * The speak URL: production unless `override` is a bare `http:` loopback
 * origin, so the token can reach only Hosted or this machine. Anything else —
 * https, a remote or LAN host, credentials, a path — is ignored, never an error.
 * `hosted/server/dev.ts` answers only its own `Host`, `127.0.0.1:<port>`.
 */
export function resolveManagedVoiceSpeakUrl(override: string | undefined): string {
  if (!override) return MANAGED_VOICE_SPEAK_URL;
  let url: URL;
  try { url = new URL(override); } catch { return MANAGED_VOICE_SPEAK_URL; }
  const bare = url.username === '' && url.password === '' && url.pathname === '/'
    && url.search === '' && url.hash === '';
  if (url.protocol !== 'http:' || !LOOPBACK_HOSTNAMES.has(url.hostname) || !bare) return MANAGED_VOICE_SPEAK_URL;
  return `${url.origin}/api/voice/speak`;
}
/** Longer than a healthy synthesis, well inside `SPEECH_ENGINE_TIMEOUT_MS`,
 *  so a hung request still leaves the attempt time to fall back to Web Speech. */
export const MANAGED_VOICE_REQUEST_TIMEOUT_MS = 15_000;
/** Hosted's own bound on `text`. */
const MAX_TEXT_LENGTH = 200;
/** A 200-character utterance is well under 1 MB of 128 kbps MP3. */
export const MAX_AUDIO_BYTES = 4 * 1024 * 1024;

/** One `voice:command` line's result: audio travels as base64 on the JSON-lines pipe. */
export type ManagedVoiceHostSpeakResult =
  | { ok: true; mime: string; audioBase64: string }
  | { ok: false; reason: ManagedVoiceFailure };

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
  /** Answer one command; `cancel` resolves `undefined` and sends nothing back. */
  handle(command: unknown): Promise<ManagedVoiceStatus | ManagedVoiceConfigResult | ManagedVoiceHostSpeakResult | undefined>;
  /** Abort every in-flight request (sidecar shutdown). */
  dispose(): void;
}

const STATUS_FOR_FAILURE: Record<number, ManagedVoiceFailure> = {
  400: 'bad-request',
  401: 'unauthorized',
  403: 'forbidden',
  429: 'rate-limited',
  502: 'upstream',
};

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
  fetch?: typeof globalThis.fetch;
  timeoutMs?: number;
  /** Defaults to `process.env`; read once, for `HOSTED_ORIGIN_ENV`. */
  env?: Record<string, string | undefined>;
  log?: (message: string) => void;
}): ManagedVoiceHost {
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? MANAGED_VOICE_REQUEST_TIMEOUT_MS;
  const log = options.log ?? (() => {});
  const stateDir = options.stateDir || undefined;
  const override = (options.env ?? process.env)[HOSTED_ORIGIN_ENV];
  const speakUrl = resolveManagedVoiceSpeakUrl(override);
  if (override) {
    log(speakUrl === MANAGED_VOICE_SPEAK_URL
      ? `[managed-voice] ignoring ${HOSTED_ORIGIN_ENV}: not an http loopback origin`
      : `[managed-voice] dev override: speaking via ${speakUrl}`);
  }
  const file = stateDir ? join(stateDir, MANAGED_VOICE_FILE) : undefined;
  const inFlight = new Map<string, AbortController>();
  let loaded: Promise<StoredConfig> | null = null;

  const load = (): Promise<StoredConfig> => {
    loaded ??= (async () => {
      if (!file) return normalizeStored(null);
      try {
        return normalizeStored(JSON.parse(await readFile(file, 'utf8')));
      } catch {
        return normalizeStored(null);
      }
    })();
    return loaded;
  };

  const status = (config: StoredConfig): ManagedVoiceStatus =>
    ({ configured: config.token !== null, voiceId: config.voiceId });

  async function configure(update: unknown): Promise<ManagedVoiceConfigResult> {
    if (!stateDir || !file) return { ok: false, reason: 'unavailable' };
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
    await writeJsonAtomic(stateDir, file, next);
    loaded = Promise.resolve(next);
    return { ok: true, ...status(next) };
  }

  async function speak(speakId: string, text: string): Promise<ManagedVoiceHostSpeakResult> {
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
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
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
        signal: controller.signal,
      });
      if (!response.ok) {
        // The body is Hosted's `{ message }`; nothing here needs it.
        await response.body?.cancel().catch(() => {});
        log(`[managed-voice] speak failed: HTTP ${response.status}`);
        return { ok: false, reason: STATUS_FOR_FAILURE[response.status] ?? 'http' };
      }
      const declared = Number(response.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_AUDIO_BYTES) {
        await response.body?.cancel().catch(() => {});
        return { ok: false, reason: 'http' };
      }
      const mime = response.headers.get('content-type')?.split(';')[0].trim() || 'audio/mpeg';
      if (!mime.startsWith('audio/')) return { ok: false, reason: 'http' };
      const bytes = Buffer.from(await response.arrayBuffer());
      if (bytes.length === 0 || bytes.length > MAX_AUDIO_BYTES) return { ok: false, reason: 'http' };
      return { ok: true, mime, audioBase64: bytes.toString('base64') };
    } catch {
      if (timedOut) return { ok: false, reason: 'timeout' };
      if (controller.signal.aborted) return { ok: false, reason: 'cancelled' };
      return { ok: false, reason: 'network' };
    } finally {
      clearTimeout(timer);
      if (inFlight.get(speakId) === controller) inFlight.delete(speakId);
    }
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
          return undefined;
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

/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Managed voice"):
 * holds the token its own Hosted approval obtains, adds it and the voice
 * id to the webview's text, caches the clips, and answers with audio or a
 * diagnostic failure. Where the request may go:
 * `docs/specs/security-local.md` -> "Persisted state".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  isBurrowVoicePollResponse,
  isManagedVoiceId,
  isManagedVoiceToken,
  type BurrowVoicePollResponse,
} from 'remote-lib-common';
import { beginHostedApproval, hostedApprovalDeadline, pollHostedApproval, slowDownHostedApproval } from '../remote/burrow/enrollment';
import { enrollVerificationUrl } from './remote/hosted-enrollment-url';
import { writeJsonAtomic } from './atomic-json-file';
import { hostedVoiceOrigin, type RelayBuild } from './relay-origin';
import { createSerialQueue } from './remote/serial-queue';
import {
  DEFAULT_MANAGED_VOICE_ID,
  MANAGED_VOICE_REQUEST_TIMEOUT_MS,
  type ManagedVoiceConfigResult,
  type ManagedVoiceEnrollment,
  type ManagedVoiceHostSpeakResult,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

export const MANAGED_VOICE_FILE = 'managed-voice.json';
const MANAGED_VOICE_SPEAK_PATH = '/api/voice/speak';
/** Where a computer turning Hosted Voice off deletes its own token. */
const MANAGED_VOICE_TOKEN_PATH = '/api/voice/token';
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

/** A voice poll's answer, rebuilt so nothing but its guarded fields goes further. */
function parseVoiceApproval(body: unknown): BurrowVoicePollResponse | null {
  if (!isBurrowVoicePollResponse(body)) return null;
  return body.status === 'enabled' ? { status: 'enabled', voiceToken: body.voiceToken } : { status: body.status };
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
   * (`docs/specs/remote-network.md` → "Policy"), asked before speech and approval requests.
   * `false` refuses before any request, a cached clip included.
   */
  networkAllowed: () => Promise<boolean>;
}): {
  handle(command: unknown): Promise<unknown>;
  dispose(): void;
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
  const tokenUrl = voice === null ? null : voice + MANAGED_VOICE_TOKEN_PATH;
  let loaded: Promise<StoredManagedVoice> | null = null;
  // Each edit reads, then rewrites the whole file: two at once would drop a field.
  const serialize = createSerialQueue();
  const clips = createClipCache();
  let notEntitled = false;
  let disabled = false;
  let disconnectFailed = false;
  /** The token a failed disconnect left in the store, which a re-read must never re-arm. */
  let uncleared: string | null = null;
  let enrollment: ManagedVoiceEnrollment | null = null;
  let enrollmentSequence = 0;
  let beginPending: Promise<void> | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;
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

  const status = (config: StoredManagedVoice): ManagedVoiceStatus =>
    ({ configured: !disabled && config.token !== null, voiceId: config.voiceId, notEntitled,
      ...(enrollment ? { enrollment } : {}), ...(disconnectFailed ? { disconnectFailed: true } : {}) });

  const announce = async () => options.onStatus(status(await load().catch(() => normalizeStored(null))));

  /** Store `edit`'s result, of which only `changed` differs, then announce it. Runs on `serialize`. */
  async function save(changed: keyof StoredManagedVoice, edit: (config: StoredManagedVoice) => StoredManagedVoice, broadcast = true): Promise<ManagedVoiceStatus> {
    if (!store) throw new Error('no owner-only store');
    const next = edit({ ...await load() });
    await store.write(next, changed);
    loaded = Promise.resolve(next);
    if (broadcast) options.onStatus(status(next));
    return status(next);
  }

  async function configure(update: unknown): Promise<ManagedVoiceConfigResult> {
    if (!store) return { ok: false, reason: 'unavailable' };
    const voiceId = (update as { voiceId?: unknown } | null)?.voiceId;
    if (!isManagedVoiceId(voiceId)) return { ok: false, reason: 'invalid-voice' };
    try {
      return { ok: true, ...await save('voiceId', (config) => ({ ...config, voiceId })) };
    } catch (error) {
      log(`[managed-voice] could not read or save: ${String(error)}`);
      return { ok: false, reason: 'unavailable' };
    }
  }

  /** Clear the stored token, memory before disk: a failed write must never leave speech armed. Runs on `serialize`. */
  async function clearToken(): Promise<void> {
    const current = await load().catch(() => normalizeStored(null));
    const next = { ...current, token: null };
    loaded = Promise.resolve(next);
    disconnectFailed = true;
    uncleared = current.token ?? uncleared;
    options.onStatus(status(next));
    if (!store) throw new Error('no owner-only store');
    await store.write(next, 'token');
    disconnectFailed = false;
    uncleared = null;
    options.onStatus(status(next));
  }

  /** Any token change forgets every clip and every refusal the old one earned. */
  const setToken = (token: string | null) => {
    const generation = ++tokenGeneration;
    if (token === null) disabled = true;
    clips.clear();
    notEntitled = false;
    return serialize(async () => {
      if (speakUrl === null) throw new Error('this build has no managed voice');
      if (token === null) {
        await clearToken();
      } else {
        await save('token', (config) => ({ ...config, token }), false);
        if (generation === tokenGeneration) disabled = false;
        disconnectFailed = false;
        await announce();
      }
    });
  };

  /**
   * A 401's answer: forget the token that was refused, never one a sibling
   * window saved since, which this window may not have re-read yet.
   */
  const forgetRefused = (refused: string) => serialize(async () => {
    if (!store || normalizeStored(await store.read()).token !== refused) return;
    tokenGeneration++;
    disabled = true;
    clips.clear();
    notEntitled = false;
    await clearToken();
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
    if (disabled || generation !== tokenGeneration || !config.token) return { ok: false, reason: 'unconfigured' };
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
          // Revoked or unknown: forgotten, so Settings offers Enable again.
          if (response.status === 401) await forgetRefused(config.token).catch(() => {});
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
      // Only for the token that asked: a disconnect meanwhile cleared the cache.
      if (generation === tokenGeneration) {
        await noteEntitled(true);
        if (generation === tokenGeneration && !disabled) clips.set(config.voiceId, trimmed, audioBase64);
      }
      return generation === tokenGeneration && !disabled
        ? { ok: true, audioBase64 } : { ok: false, reason: 'disconnected' };
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

  /**
   * Best effort, never awaited by turning off: delete `token` at Hosted, so a
   * computer that turned Hosted Voice off leaves nothing live there. Skipped
   * under Nowhere, failed offline; either way the token lapses unused.
   */
  async function forgetAtHosted(token: string): Promise<void> {
    try {
      if (tokenUrl === null || !(await options.networkAllowed())) return;
      const response = await fetchImpl(tokenUrl, {
        method: 'DELETE',
        headers: { authorization: `Bearer ${token}` },
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
      await response?.body?.cancel();
    } catch {
      // Unreachable, or refused: the token lapses unused.
    }
  }

  function cancelEnrollment(): void {
    enrollmentSequence++;
    if (pollTimer) clearTimeout(pollTimer);
    pollTimer = undefined;
    beginPending = null;
    enrollment = null;
  }

  async function requireEnrollmentNetwork(): Promise<void> {
    if (speakUrl === null) throw new Error('This build has no Hosted Voice.');
    if (!(await options.networkAllowed())) throw new Error('Network is set to Nowhere.');
  }

  const enrollmentFetch: typeof globalThis.fetch = async (url, init) => {
    await requireEnrollmentNetwork();
    return fetchImpl(url, init);
  };

  async function beginEnrollment(): Promise<void> {
    if (enrollment?.status === 'waiting' || enrollment?.status === 'saving') return;
    if (beginPending) return beginPending;
    if (disconnectFailed) throw new Error('Finish turning Hosted Voice off before turning it on.');
    const sequence = ++enrollmentSequence;
    const begin = async () => {
      if (status(await load()).configured) throw new Error('Hosted Voice is already on.');
      if (sequence !== enrollmentSequence) return;
      const body = await beginHostedApproval(options.relay.origin, 'voice', enrollmentFetch);
      if (sequence !== enrollmentSequence) return;
      const url = new URL(enrollVerificationUrl(options.relay, body, 'voice'));
      const deadline = hostedApprovalDeadline(body.expiresAt, Date.now());
      enrollment = { status: 'waiting', userCode: body.userCode, expiresAt: deadline, verificationUrl: url.href };
      await announce();
      let intervalMs = body.interval * 1000;
      const schedule = () => {
        if (sequence === enrollmentSequence) pollTimer = setTimeout(() => void poll(), intervalMs);
      };
      const poll = async () => {
        try {
          if (sequence !== enrollmentSequence) return;
          if (Date.now() >= deadline) throw new Error('That code expired. Turn on Hosted Voice to get a new code.');
          // Check outside the retrying exchange too: Nowhere ends this run.
          await requireEnrollmentNetwork();
          const answer = await pollHostedApproval(options.relay.origin, body.deviceCode, 'voice', enrollmentFetch, parseVoiceApproval);
          if (sequence !== enrollmentSequence) return;
          if (answer.status === 'retry') {
            if (answer.slowDown) intervalMs = slowDownHostedApproval(intervalMs);
            schedule();
            return;
          }
          if (answer.status === 'refused') throw new Error('That account has no Hosted plan.');
          if (answer.status === 'failed') throw new Error(answer.message);
          if (answer.status === 'pending') { schedule(); return; }
          if (answer.status === 'enabled') {
            enrollment = { status: 'saving' };
            await announce();
            if (sequence !== enrollmentSequence) return;
            // A token never saved, or never received below, is held by no one,
            // so the user is never asked to revoke it.
            try { await setToken(answer.voiceToken); }
            catch { throw new Error('Could not save Hosted Voice on this computer. Try again.'); }
            if (sequence === enrollmentSequence) { enrollment = null; await announce(); }
            return;
          }
          throw new Error(answer.status === 'redeemed'
            ? 'Hosted Voice could not finish turning on. Try again.'
            : 'That approval ended. Turn on Hosted Voice to get a new code.');
        } catch (error) {
          if (sequence !== enrollmentSequence) return;
          enrollment = { status: 'ended', message: error instanceof Error ? error.message : String(error) };
          await announce();
        }
      };
      schedule();
    };
    const pending = begin();
    beginPending = pending;
    try { await pending; } finally { if (beginPending === pending) beginPending = null; }
  }

  async function action(op: string) {
    try {
      if (op === 'beginEnrollment') await beginEnrollment();
      else {
        cancelEnrollment();
        if (op === 'disconnect') {
          disabled = true;
          // A retry's token is the one the failed clear left behind.
          const held = (await load().catch(() => null))?.token ?? uncleared;
          try {
            await setToken(null);
          } finally {
            if (held !== null) void forgetAtHosted(held);
          }
        } else await announce();
      }
      return { ok: true, ...status(await load()) };
    } catch (error) {
      log(`[managed-voice] ${op} failed: ${String(error)}`);
      return { ok: false, message: op === 'disconnect'
        ? 'Hosted Voice is off for this session, but turning it off did not finish. Retry before restarting Dormouse.'
        : error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    dispose: cancelEnrollment,
    invalidate() {
      if (speakUrl === null) return;
      // On `serialize`, after any save in flight: a save that read before the
      // sibling's change would otherwise cache its stale merge over this
      // re-read, and this window's own write, heard back mid-save, would
      // compare against the value it was replacing.
      void serialize(async () => {
        const previous = await loaded?.catch(() => null) ?? null;
        loaded = null;
        const next = await load();
        if (previous?.token === next.token && previous.voiceId === next.voiceId) return;
        if (next.token !== null && next.token === uncleared) {
          // This window's failed disconnect, read back: still off.
          loaded = Promise.resolve({ ...next, token: null });
        } else if (previous?.token !== next.token) {
          // A sibling's enable or disconnect supersedes this window's: its
          // clips, refusal, and any disconnect still owed are for a token
          // the store no longer holds.
          uncleared = null;
          tokenGeneration++;
          clips.clear();
          notEntitled = false;
          disabled = false;
          disconnectFailed = false;
        }
        options.onStatus(status(next));
      }).catch(() => {});
    },
    async handle(command) {
      const message = (command ?? {}) as Record<string, unknown>;
      switch (message.op) {
        case 'beginEnrollment':
        case 'cancelEnrollment':
        case 'disconnect': return action(message.op);
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

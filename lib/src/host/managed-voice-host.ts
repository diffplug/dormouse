/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Managed voice"):
 * holds the token its own Hosted approval obtains, adds it and the voice
 * id to the webview's text, and answers with audio or a diagnostic failure.
 * Where the request may go:
 * `docs/specs/security-local.md` -> "Persisted state".
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { isManagedVoiceId, isManagedVoiceToken } from 'remote-lib-common';
import { beginHostedApproval, pollHostedVoiceApproval } from '../remote/burrow/enrollment';
import { HostedApproval } from './remote/hosted-approval';
import { enrollVerificationUrl } from './remote/hosted-enrollment-url';
import { writeJsonAtomic } from './atomic-json-file';
import { hostedVoiceOrigin, type RelayBuild } from './relay-origin';
import { createSerialQueue } from './remote/serial-queue';
import {
  DEFAULT_MANAGED_VOICE_ID,
  MANAGED_VOICE_REQUEST_TIMEOUT_MS,
  type ManagedVoiceConfigResult,
  type ManagedVoiceHostSpeakResult,
  type ManagedVoiceStatus,
} from '../lib/platform/managed-voice-types';

export const MANAGED_VOICE_FILE = 'managed-voice.json';
const MANAGED_VOICE_SPEAK_PATH = '/api/voice/speak';
/** Where a computer turning Natural Voice off deletes its own token. */
const MANAGED_VOICE_TOKEN_PATH = '/api/voice/token';
/** Hosted's own bound on `text`. */
const MAX_TEXT_LENGTH = 200;
/** `docs/specs/standalone.md` -> "Rust ↔ sidecar bridge". */
export const MAX_AUDIO_BYTES = 512 * 1024;

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
  /**
   * Persist `next[changed]` alone, keeping the other field as stored: a
   * caller whose read failed passes defaults there, which must never land.
   */
  write(next: StoredManagedVoice, changed: keyof StoredManagedVoice): Promise<void>;
}

/**
 * The sidecar's store: `managed-voice.json` in the owner-only state directory,
 * rewritten whole from a fresh read, so a write fails rather than reset the
 * field it was not given.
 */
export function fileManagedVoiceStore(stateDir: string): ManagedVoiceStore {
  const file = join(stateDir, MANAGED_VOICE_FILE);
  async function read(): Promise<unknown> {
    try {
      return JSON.parse(await readFile(file, 'utf8'));
    } catch (error) {
      // Only a missing or unparsable file is "no config": a transient lock
      // (EBUSY, EPERM, EMFILE) is retried on the next read.
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) return null;
      throw error;
    }
  }
  return {
    read,
    write: async (next, changed) =>
      writeJsonAtomic(stateDir, file, { ...normalizeStored(await read()), [changed]: next[changed] }),
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
   * `false` refuses before any request.
   */
  networkAllowed: () => Promise<boolean>;
}): {
  handle(command: unknown): Promise<unknown>;
  dispose(): void;
  /**
   * Another process may have changed the store (a sibling VS Code window):
   * read it again, and announce what changed. A changed token forgets the
   * refusal the old one earned; this window's own write, heard back, changes
   * nothing.
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
  // Each edit derives its record from the loaded one: two at once would drop one's change.
  const serialize = createSerialQueue();
  let notEntitled = false;
  let disabled = false;
  let disconnectFailed = false;
  /** The token a failed disconnect left in the store, which a re-read must never re-arm. */
  let uncleared: string | null = null;
  /** Bumped by every token change, so a request that outlived its token changes nothing. */
  let tokenGeneration = 0;

  const load = (): Promise<StoredManagedVoice> => {
    loaded ??= (store ? store.read() : Promise.resolve(null)).then(normalizeStored, (error: unknown) => {
      // Never cached: the next read tries again.
      loaded = null;
      throw error;
    });
    return loaded;
  };

  const status = (config: StoredManagedVoice): ManagedVoiceStatus => {
    const enrollment = approval.state();
    return { configured: !disabled && config.token !== null, voiceId: config.voiceId, notEntitled,
      ...(enrollment ? { enrollment } : {}), ...(disconnectFailed ? { disconnectFailed: true } : {}) };
  };

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
    // Unread, the voice is unknown: never cached, and the store keeps it.
    const current = await load().catch(() => null);
    loaded = current ? Promise.resolve({ ...current, token: null }) : null;
    disconnectFailed = true;
    uncleared = current?.token ?? uncleared;
    await announce();
    if (!store) throw new Error('no owner-only store');
    await store.write({ ...current ?? normalizeStored(null), token: null }, 'token');
    disconnectFailed = false;
    uncleared = null;
    await announce();
  }

  /** Any token change forgets the refusal the old one earned. */
  const setToken = (token: string | null) => {
    const generation = ++tokenGeneration;
    if (token === null) disabled = true;
    notEntitled = false;
    return serialize(async () => {
      if (speakUrl === null) throw new Error('this build has no managed voice');
      if (token === null) {
        // Read here, after any save queued first: a token a disconnect
        // overtakes mid-save is deleted too. A retry's is the one the failed
        // clear left behind.
        const held = (await load().catch(() => null))?.token ?? uncleared;
        try {
          await clearToken();
        } finally {
          if (held !== null) void forgetAtHosted(held);
        }
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
    // request's answer play or latch a refusal against the new token.
    const generation = tokenGeneration;
    const config = await load().catch(() => null);
    if (!config) return { ok: false, reason: 'config unreadable' };
    if (disabled || generation !== tokenGeneration || !config.token) return { ok: false, reason: 'unconfigured' };
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
      // Only for the token that asked: a disconnect meanwhile wins.
      if (generation === tokenGeneration) await noteEntitled(true);
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
   * Best effort, never awaited: delete `token` at Hosted, so a token this
   * computer turned off or discarded unsaved leaves nothing live there.
   * Skipped under Nowhere, failed offline; either way the token lapses unused.
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

  async function requireEnrollmentNetwork(): Promise<void> {
    if (speakUrl === null) throw new Error('This build has no Natural Voice.');
    if (!(await options.networkAllowed())) throw new Error('Network is set to Nowhere.');
  }

  const enrollmentFetch: typeof globalThis.fetch = async (url, init) => {
    await requireEnrollmentNetwork();
    return fetchImpl(url, init);
  };

  /**
   * Natural Voice's own approval: the shared device-code run, its credential
   * the voice token. A token this host discards — the approval canceled or
   * overtaken, or the save failed — is held by no one, so it is deleted at
   * Hosted.
   */
  const approval = new HostedApproval<void, null, string>({
    begin: async () => {
      if (disconnectFailed) throw new Error('Finish turning Natural Voice off before turning it on.');
      if (status(await load()).configured) throw new Error('Natural Voice is already on.');
      return { begin: await beginHostedApproval(options.relay.origin, 'voice', enrollmentFetch), held: null };
    },
    verificationUrl: (begin) => new URL(enrollVerificationUrl(options.relay, begin, 'voice')).href,
    poll: async (deviceCode) => {
      // Checked outside the retrying exchange too: Nowhere ends this run.
      await requireEnrollmentNetwork();
      return pollHostedVoiceApproval(options.relay.origin, deviceCode, enrollmentFetch);
    },
    redeem: async (token, current) => {
      if (!current) {
        void forgetAtHosted(token);
        return false;
      }
      try {
        await setToken(token);
      } catch {
        void forgetAtHosted(token);
        throw new Error('Could not save Natural Voice on this computer. Try again.');
      }
      return true;
    },
  }, { onChange: () => void announce(), log });

  async function action(op: string) {
    try {
      if (op === 'beginEnrollment') await approval.begin();
      else {
        approval.cancel();
        if (op === 'disconnect') {
          disabled = true;
          await setToken(null);
        } else await announce();
      }
      return { ok: true, ...status(await load()) };
    } catch (error) {
      log(`[managed-voice] ${op} failed: ${String(error)}`);
      return { ok: false, message: op === 'disconnect'
        ? 'Natural Voice is off for this session, but turning it off did not finish. Retry before restarting Dormouse.'
        : error instanceof Error ? error.message : String(error) };
    }
  }

  return {
    dispose: () => approval.dispose(),
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
          // refusal, and any disconnect still owed, are for a token the store
          // no longer holds.
          uncleared = null;
          tokenGeneration++;
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

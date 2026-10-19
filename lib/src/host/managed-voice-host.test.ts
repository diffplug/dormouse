import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CLIP_CACHE_MAX_BYTES,
  CLIP_CACHE_MAX_ENTRIES,
  createManagedVoiceHost,
  fileManagedVoiceStore,
  MAX_AUDIO_BYTES,
  MANAGED_VOICE_FILE,
} from './managed-voice-host';
import { DEFAULT_MANAGED_VOICE_ID, MANAGED_VOICES } from '../lib/platform/managed-voice-types';
import { DEFAULT_RELAY_ORIGIN } from './relay-origin';

/**
 * A fixed origin, never the relay origin (`docs/specs/relay.md` → "Relay
 * origin"): changing it changes where every shipped binary sends the token.
 */
const MANAGED_VOICE_SPEAK_URL = 'https://voice.dormouse.sh/api/voice/speak';
const MANAGED_VOICE_TOKEN_URL = 'https://voice.dormouse.sh/api/voice/token';
/** Each request's URL, method, and bearer. */
const requests = () => fetchMock.mock.calls.map(([url, init]: [string, RequestInit]) =>
  [url, init.method, (init.headers as Record<string, string>).authorization]);

/** The next `readFile` fails with this, once: a Windows antivirus lock, say. */
const readFault = vi.hoisted(() => ({ next: null as NodeJS.ErrnoException | null }));
const renameFault = vi.hoisted(() => ({ next: null as NodeJS.ErrnoException | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    rename: (async (...args: Parameters<typeof actual.rename>) => {
      const fault = renameFault.next;
      renameFault.next = null;
      if (fault) throw fault;
      return actual.rename(...args);
    }) as typeof actual.rename,
    readFile: (async (...args: Parameters<typeof actual.readFile>) => {
      const fault = readFault.next;
      readFault.next = null;
      if (fault) throw fault;
      return actual.readFile(...args);
    }) as typeof actual.readFile,
  };
});

/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Spoken alarms"):
 * the token stays here, the request is shaped per the wire contract, and every
 * failure becomes a kind the renderer falls back on.
 */

const TOKEN = `dmv_${'A'.repeat(43)}`;
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
let broadcasts: unknown[];
let host: ReturnType<typeof make>;

function make(options: { timeoutMs?: number; stateDir?: string; networkAllowed?: () => Promise<boolean> } = {}) {
  return createManagedVoiceHost({
    store: 'stateDir' in options ? (options.stateDir ? fileManagedVoiceStore(options.stateDir) : undefined) : fileManagedVoiceStore(dir),
    onStatus: (status) => void broadcasts.push(status),
    fetch: fetchMock as unknown as typeof fetch,
    timeoutMs: options.timeoutMs,
    relay: { origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' },
    networkAllowed: options.networkAllowed ?? (async () => true),
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'managed-voice-'));
  fetchMock = vi.fn();
  broadcasts = [];
  host = make();
});

afterEach(async () => {
  host.dispose();
  vi.useRealTimers();
  await rm(dir, { recursive: true, force: true });
});

const audioResponse = () => new Response(new Uint8Array([9, 8, 7]), {
  status: 200, headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
});

const OTHER_VOICE = MANAGED_VOICES[1]!.id;
const idle = (configured: boolean, voiceId = DEFAULT_MANAGED_VOICE_ID) =>
  ({ configured, voiceId, notEntitled: false });

async function seedToken(token = TOKEN): Promise<void> {
  await writeFile(join(dir, MANAGED_VOICE_FILE), JSON.stringify({ token, voiceId: DEFAULT_MANAGED_VOICE_ID }), { mode: 0o600 });
}

const begun = () => ({ purpose: 'voice', deviceCode: 'A'.repeat(43), userCode: '7KQM-X4TD', expiresAt: Date.now() + 600_000, interval: 1 });

async function approveVoice(target = host, token = TOKEN) {
  vi.useFakeTimers();
  try {
    fetchMock.mockResolvedValueOnce(Response.json(begun())).mockResolvedValueOnce(Response.json({ status: 'enabled', voiceToken: token }));
    expect(await target.handle({ op: 'beginEnrollment' })).toMatchObject({ ok: true });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => {
      const status = await target.handle({ op: 'status' }) as { enrollment?: { status: string } };
      expect(['waiting', 'saving']).not.toContain(status.enrollment?.status);
    });
  } finally {
    vi.useRealTimers();
  }
}

describe('configuration', () => {
  it('holds the token enrollment saves, and reports and broadcasts without ever carrying it', async () => {
    expect(await host.handle({ op: 'status' })).toEqual(idle(false));
    await approveVoice();
    expect(broadcasts.at(-1)).toEqual(idle(true));
    expect(JSON.stringify([broadcasts, await host.handle({ op: 'status' })])).not.toContain(TOKEN);
  });

  it('takes no token from a webview command', async () => {
    expect(await host.handle({ op: 'configure', update: { token: TOKEN } })).toEqual({ ok: false, reason: 'invalid-voice' });
    expect(await host.handle({ op: 'status' })).toEqual(idle(false));
  });

  it('keeps both of two edits sent at once', async () => {
    await Promise.all([
      approveVoice(),
      host.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } }),
    ]);
    expect(JSON.parse(await readFile(join(dir, MANAGED_VOICE_FILE), 'utf8'))).toEqual({ token: TOKEN, voiceId: OTHER_VOICE });
    expect(broadcasts.at(-1)).toEqual(idle(true, OTHER_VOICE));
  });

  it('persists owner-only and survives a restart', async () => {
    await approveVoice();
    await host.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } });
    const file = join(dir, MANAGED_VOICE_FILE);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: TOKEN, voiceId: OTHER_VOICE });
    expect(await make().handle({ op: 'status' })).toEqual(idle(true, OTHER_VOICE));
  });

  it('refuses a voice outside the curated set without storing it', async () => {
    for (const voiceId of ['../x', 'AZnzlk1XvdvUeBnXmlld', 7]) {
      expect(await host.handle({ op: 'configure', update: { voiceId } })).toEqual({ ok: false, reason: 'invalid-voice' });
    }
    expect(await host.handle({ op: 'status' })).toEqual(idle(false));
    expect(broadcasts).toEqual([]);
  });

  it('clears the token at disconnect', async () => {
    await seedToken();
    await host.handle({ op: 'disconnect' });
    expect(broadcasts.at(-1)).toEqual(idle(false));
    expect(JSON.parse(await readFile(join(dir, MANAGED_VOICE_FILE), 'utf8')).token).toBeNull();
  });

  it('deletes its own token at Hosted on disconnect, never waiting for the answer', async () => {
    await seedToken();
    let answer!: (response: Response) => void;
    fetchMock.mockReturnValueOnce(new Promise<Response>((resolve) => { answer = resolve; }));
    expect(await host.handle({ op: 'disconnect' })).toMatchObject({ ok: true, configured: false });
    await vi.waitFor(() => expect(requests()).toEqual([[MANAGED_VOICE_TOKEN_URL, 'DELETE', `Bearer ${TOKEN}`]]));
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ redirect: 'error' });
    answer(new Response(null, { status: 204 }));
  });

  it('disconnects locally whatever Hosted answers, and asks Hosted nothing under Nowhere', async () => {
    await seedToken();
    fetchMock.mockRejectedValue(new Error('offline'));
    expect(await host.handle({ op: 'disconnect' })).toMatchObject({ ok: true, configured: false });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    fetchMock.mockClear();
    const nowhere = make({ networkAllowed: async () => false });
    await seedToken();
    expect(await nowhere.handle({ op: 'disconnect' })).toMatchObject({ ok: true, configured: false });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('treats a corrupt or hand-edited file as unconfigured, and a retired voice as the default', async () => {
    await writeFile(join(dir, MANAGED_VOICE_FILE), JSON.stringify({ token: 'dmv_short', voiceId: 7 }));
    expect(await make().handle({ op: 'status' })).toEqual(idle(false));
    await writeFile(join(dir, MANAGED_VOICE_FILE), JSON.stringify({ token: TOKEN, voiceId: 'abc123' }));
    expect(await make().handle({ op: 'status' })).toEqual(idle(true));
  });

  it('keeps a saved token through a read error, and reads again next time', async () => {
    await seedToken();
    const file = join(dir, MANAGED_VOICE_FILE);
    const restarted = make();
    readFault.next = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    expect(await restarted.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } }))
      .toEqual({ ok: false, reason: 'unavailable' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: TOKEN, voiceId: DEFAULT_MANAGED_VOICE_ID });

    expect(await restarted.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } }))
      .toEqual({ ok: true, ...idle(true, OTHER_VOICE) });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: TOKEN, voiceId: OTHER_VOICE });
  });

  it('refuses to hold a token with nowhere owner-only to keep it', async () => {
    const unavailable = make({ stateDir: undefined });
    await approveVoice(unavailable);
    expect(await unavailable.handle({ op: 'status' })).toMatchObject({ configured: false, enrollment: { status: 'ended', message: expect.stringContaining('Could not save') } });
  });
});

describe('speak', () => {
  beforeEach(async () => {
    await seedToken();
  });

  it('sends only the text and voice id, with the bearer token, and returns the audio', async () => {
    fetchMock.mockResolvedValue(audioResponse());
    const result = await host.handle({ op: 'speak', text: 'build finished' });
    expect(result).toEqual({ ok: true, audioBase64: Buffer.from([9, 8, 7]).toString('base64') });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MANAGED_VOICE_SPEAK_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ text: 'build finished', voiceId: DEFAULT_MANAGED_VOICE_ID });
  });

  it('answers unconfigured without a request', async () => {
    await host.handle({ op: 'disconnect' });
    expect(await host.handle({ op: 'speak', text: 'x' })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(requests().filter(([url]) => url === MANAGED_VOICE_SPEAK_URL)).toEqual([]);
  });

  it('forgets a token Hosted no longer knows, so Settings asks for a fresh enrollment', async () => {
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    expect(await host.handle({ op: 'speak', text: 'x' })).toEqual({ ok: false, reason: 'HTTP 401' });
    expect(broadcasts.at(-1)).toEqual(idle(false));
    expect(JSON.parse(await readFile(join(dir, MANAGED_VOICE_FILE), 'utf8')).token).toBeNull();
  });

  it.each([400, 401, 403, 429, 502])('reports HTTP %i as a failure', async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'no' }), { status }));
    expect(await host.handle({ op: 'speak', text: 'x' })).toEqual({ ok: false, reason: `HTTP ${status}` });
  });

  it.each(['text/html', 'audio/wav'])('refuses a %s success body', async (type) => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200, headers: { 'content-type': type } }));
    expect(await host.handle({ op: 'speak', text: 'x' })).toMatchObject({ ok: false });
  });

  it('refuses audio over the size cap', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(MAX_AUDIO_BYTES + 1), {
      status: 200, headers: { 'content-type': 'audio/mpeg' },
    }));
    expect(await host.handle({ op: 'speak', text: 'x' })).toMatchObject({ ok: false });
  });

  it('reports a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('getaddrinfo ENOTFOUND voice.dormouse.sh'));
    expect(await host.handle({ op: 'speak', text: 'x' })).toEqual({ ok: false, reason: 'network' });
  });

  const hangingFetch = () => fetchMock.mockImplementation((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

  it('times out a hung request', async () => {
    hangingFetch();
    const quick = make({ timeoutMs: 5 });
    expect(await quick.handle({ op: 'speak', text: 'x' })).toEqual({ ok: false, reason: 'timeout' });
  });

  it('caches a clip by voice and text, so a repeat makes no request', async () => {
    fetchMock.mockImplementation(async () => audioResponse());
    const first = await host.handle({ op: 'speak', text: 'build finished' });
    expect(await host.handle({ op: 'speak', text: '  build finished ' })).toEqual(first);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // Another voice, or another label, asks again.
    await host.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } });
    await host.handle({ op: 'speak', text: 'build finished' });
    await host.handle({ op: 'speak', text: 'tests failed' });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('bounds the cache by count, evicting the least recently used', async () => {
    fetchMock.mockImplementation(async () => audioResponse());
    for (let i = 0; i <= CLIP_CACHE_MAX_ENTRIES; i++) await host.handle({ op: 'speak', text: `pane ${i}` });
    fetchMock.mockClear();
    await host.handle({ op: 'speak', text: `pane ${CLIP_CACHE_MAX_ENTRIES}` });
    expect(fetchMock).not.toHaveBeenCalled();
    await host.handle({ op: 'speak', text: 'pane 0' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('bounds the cache by bytes', async () => {
    const clip = Math.floor(CLIP_CACHE_MAX_BYTES / 2) + 1;
    fetchMock.mockImplementation(async () => new Response(new Uint8Array(Math.min(clip, MAX_AUDIO_BYTES)), {
      status: 200, headers: { 'content-type': 'audio/mpeg' },
    }));
    // Each clip at the audio cap: the cache holds what fits in its bytes, no more.
    const fits = Math.floor(CLIP_CACHE_MAX_BYTES / Math.min(clip, MAX_AUDIO_BYTES));
    for (let i = 0; i <= fits; i++) await host.handle({ op: 'speak', text: `pane ${i}` });
    fetchMock.mockClear();
    await host.handle({ op: 'speak', text: 'pane 0' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('forgets every clip when the token changes', async () => {
    fetchMock.mockImplementation(async () => audioResponse());
    await host.handle({ op: 'speak', text: 'build finished' });
    await host.handle({ op: 'disconnect' });
    await approveVoice(host, `dmv_${'C'.repeat(43)}`);
    await host.handle({ op: 'speak', text: 'build finished' });
    expect(fetchMock.mock.calls.filter(([url]) => url === MANAGED_VOICE_SPEAK_URL)).toHaveLength(2);
  });

  it('latches a 403 as not entitled, bypassing the cache, until a speak succeeds', async () => {
    fetchMock.mockImplementation(async () => audioResponse());
    await host.handle({ op: 'speak', text: 'build finished' });
    fetchMock.mockImplementation(async () => new Response('{}', { status: 403 }));
    // Cached: no request, so nothing learned yet.
    expect(await host.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: true });
    expect(await host.handle({ op: 'speak', text: 'tests failed' })).toEqual({ ok: false, reason: 'HTTP 403' });
    expect(broadcasts.at(-1)).toEqual({ ...idle(true), notEntitled: true });
    // Lapsed: the cached clip is not played, so the system voice speaks.
    expect(await host.handle({ op: 'speak', text: 'build finished' })).toEqual({ ok: false, reason: 'HTTP 403' });
    fetchMock.mockImplementation(async () => audioResponse());
    expect(await host.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: true });
    expect(broadcasts.at(-1)).toEqual(idle(true));
  });

  it('lets an answer for a replaced token neither latch a refusal nor cache a clip', async () => {
    const answers: Array<(response: Response) => void> = [];
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => void answers.push(resolve)));
    const refused = host.handle({ op: 'speak', text: 'build finished' });
    const spoken = host.handle({ op: 'speak', text: 'tests failed' });
    await vi.waitFor(() => expect(answers).toHaveLength(2));
    // Enrolled again while both are out.
    await host.handle({ op: 'disconnect' });
    await approveVoice(host, `dmv_${'C'.repeat(43)}`);
    answers[0]!(new Response('{}', { status: 403 }));
    answers[1]!(audioResponse());
    await Promise.all([refused, spoken]);
    expect(broadcasts.at(-1)).toEqual(idle(true));
    fetchMock.mockImplementation(async () => audioResponse());
    await host.handle({ op: 'speak', text: 'tests failed' });
    expect(fetchMock.mock.calls.filter(([url]) => url === MANAGED_VOICE_SPEAK_URL)).toHaveLength(3);
  });

  it('refuses empty or over-long text', async () => {
    expect(await host.handle({ op: 'speak', text: '   ' })).toEqual({ ok: false, reason: 'bad-request' });
    expect(await host.handle({ op: 'speak', text: 'x'.repeat(201) })).toEqual({ ok: false, reason: 'bad-request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('a store another process shares', () => {
  const OTHER_TOKEN = `dmv_${'C'.repeat(43)}`;
  let shared: Record<string, unknown>;
  let writes: string[];
  let writeFault: ((changed: string, next: { token: string | null }) => Promise<void> | void) | null;

  function sharing() {
    return createManagedVoiceHost({
      store: {
        read: async () => ({ ...shared }),
        write: async (next, changed) => {
          writes.push(changed);
          await writeFault?.(changed, next);
          shared = { ...shared, [changed]: next[changed] };
        },
      },
      onStatus: (status) => void broadcasts.push(status),
      fetch: fetchMock as unknown as typeof fetch,
      relay: { origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' },
      networkAllowed: async () => true,
    });
  }

  beforeEach(() => {
    shared = { token: TOKEN };
    writes = [];
    writeFault = null;
  });

  it('writes only the field that changed, and invalidate reads a sibling’s change, forgetting the clips', async () => {
    const window = sharing();
    await window.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } });
    expect(writes).toEqual(['voiceId']);
    fetchMock.mockImplementation(async () => audioResponse());
    await window.handle({ op: 'speak', text: 'build finished' });

    // A sibling window disconnected.
    shared = { voiceId: OTHER_VOICE };
    window.invalidate();
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual(idle(false, OTHER_VOICE)));
    expect(await window.handle({ op: 'speak', text: 'build finished' })).toEqual({ ok: false, reason: 'unconfigured' });
    // Enabled again there: the old clip is not replayed.
    shared = { token: OTHER_TOKEN, voiceId: OTHER_VOICE };
    window.invalidate();
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual(idle(true, OTHER_VOICE)));
    await window.handle({ op: 'speak', text: 'build finished' });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a sibling’s disconnect heard while a save is out wins over the save’s earlier read', async () => {
    const window = sharing();
    let release: (() => void) | null = null;
    writeFault = (changed) => changed === 'voiceId' ? new Promise<void>((resolve) => { release = resolve; }) : undefined;
    const configured = window.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } });
    await vi.waitFor(() => expect(release).not.toBeNull());

    // A sibling window disconnected while this one's voice write is out.
    shared = { voiceId: shared.voiceId };
    window.invalidate();
    release!();
    await configured;

    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual(idle(false, OTHER_VOICE)));
    expect(await window.handle({ op: 'speak', text: 'build finished' })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('a 401 forgets only the refused token, never one a sibling saved before this window re-read', async () => {
    const window = sharing();
    let answer: ((response: Response) => void) | null = null;
    fetchMock.mockImplementation(() => new Promise<Response>((resolve) => { answer = resolve; }));
    const spoken = window.handle({ op: 'speak', text: 'build finished' });
    await vi.waitFor(() => expect(answer).not.toBeNull());

    // Revoked at the account page, then enabled again in a sibling window,
    // whose change this window has not re-read when the old token's 401 lands.
    shared = { ...shared, token: OTHER_TOKEN };
    answer!(new Response('{}', { status: 401 }));
    expect(await spoken).toEqual({ ok: false, reason: 'HTTP 401' });
    expect(shared.token).toBe(OTHER_TOKEN);
    expect(writes).toEqual([]);

    // Without a sibling's change, the refused token is forgotten.
    shared = { ...shared, token: TOKEN };
    const alone = sharing();
    fetchMock.mockResolvedValue(new Response('{}', { status: 401 }));
    await alone.handle({ op: 'speak', text: 'build finished' });
    expect(shared.token).toBeNull();
    expect(await alone.handle({ op: 'status' })).toMatchObject({ configured: false });
  });

  it('a re-read never re-arms a token this window failed to clear, and a sibling’s new token supersedes it', async () => {
    const window = sharing();
    writeFault = (changed, next) => {
      if (changed === 'token' && next.token === null) throw new Error('write denied');
    };
    expect(await window.handle({ op: 'disconnect' })).toMatchObject({ ok: false });

    // Any change to the shared store, the voice here, makes every window re-read.
    shared = { ...shared, voiceId: OTHER_VOICE };
    window.invalidate();
    await vi.waitFor(() => expect(broadcasts.at(-1)).toMatchObject({ configured: false, voiceId: OTHER_VOICE, disconnectFailed: true }));
    expect(await window.handle({ op: 'speak', text: 'build finished' })).toEqual({ ok: false, reason: 'unconfigured' });

    // A sibling enabled managed voice anew: nothing of this window's disconnect is owed.
    shared = { token: OTHER_TOKEN, voiceId: OTHER_VOICE };
    window.invalidate();
    await vi.waitFor(() => expect(broadcasts.at(-1)).toEqual(idle(true, OTHER_VOICE)));
    fetchMock.mockImplementation(async () => audioResponse());
    expect(await window.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: true });
    expect(requests().filter(([url]) => url === MANAGED_VOICE_SPEAK_URL)).toEqual([
      [MANAGED_VOICE_SPEAK_URL, 'POST', `Bearer ${OTHER_TOKEN}`],
    ]);
  });
});

describe('the build it runs in', () => {
  it('speaks to the voice origin from any Hosted build, a dev build’s local Hosted included', async () => {
    const local = createManagedVoiceHost({
      store: fileManagedVoiceStore(dir),
      onStatus: () => {},
      fetch: fetchMock as unknown as typeof fetch,
      relay: { origin: 'http://localhost:8787', mode: 'hosted' },
      networkAllowed: async () => true,
    });
    await seedToken();
    fetchMock.mockResolvedValue(audioResponse());

    expect(await local.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0]![0]).toBe(MANAGED_VOICE_SPEAK_URL);
  });

  it('sends nothing from a self-host build, whatever a Hosted build saved', async () => {
    // A token saved by a Hosted build on this machine is still on disk; a
    // self-host build reaches nothing of Dormouse's (docs/specs/relay.md →
    // "Relay origin"), so it reads none of it.
    await seedToken();
    const selfHost = createManagedVoiceHost({
      store: fileManagedVoiceStore(dir),
      onStatus: (status) => void broadcasts.push(status),
      fetch: fetchMock as unknown as typeof fetch,
      relay: { origin: 'https://relay.example.ts.net', mode: 'self-host' },
      networkAllowed: async () => true,
    });
    broadcasts = [];

    expect(await selfHost.handle({ op: 'status' })).toEqual(idle(false));
    expect(await selfHost.handle({ op: 'beginEnrollment' })).toMatchObject({ ok: false });
    expect(await selfHost.handle({ op: 'configure', update: { voiceId: OTHER_VOICE } })).toEqual({
      ok: false,
      reason: 'unavailable',
    });
    expect(await selfHost.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: false });
    expect(fetchMock).not.toHaveBeenCalled();
    expect(broadcasts).toEqual([]);
    expect(JSON.parse(await readFile(join(dir, MANAGED_VOICE_FILE), 'utf8'))).toEqual({
      token: TOKEN,
      voiceId: DEFAULT_MANAGED_VOICE_ID,
    });
  });
});

describe('the network policy', () => {
  it('sends nothing under Nothing, asking again at every speak', async () => {
    // docs/specs/remote-network.md → "Policy": managed voice is a choke point
    // of its own, a cached clip included. Saving a token is local, so it still works.
    let allowed = true;
    const gated = make({ networkAllowed: async () => allowed });
    await seedToken();
    fetchMock.mockResolvedValue(audioResponse());
    expect(await gated.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: true });
    fetchMock.mockClear();
    allowed = false;
    fetchMock.mockResolvedValue(audioResponse());

    expect(await gated.handle({ op: 'speak', text: 'build finished' })).toEqual({
      ok: false,
      reason: 'network-off',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    allowed = true;
    expect(await gated.handle({ op: 'speak', text: 'something new' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});


describe('independent managed-voice lifecycle', () => {
  it('disables speech and reports a failed persisted clear, with a successful retry surviving restart', async () => {
    await seedToken();
    fetchMock.mockResolvedValue(audioResponse());
    await host.handle({ op: 'speak', text: 'cached label' });
    fetchMock.mockClear();
    const file = join(dir, MANAGED_VOICE_FILE);
    renameFault.next = Object.assign(new Error('write denied'), { code: 'EACCES' });
    const result = await host.handle({ op: 'disconnect' });
    expect(result).toMatchObject({ ok: false, message: expect.stringContaining('Retry before restarting') });
    expect(await host.handle({ op: 'status' })).toMatchObject({ configured: false, disconnectFailed: true });
    for (const text of ['cached label', 'new private label']) {
      expect(await host.handle({ op: 'speak', text })).toEqual({ ok: false, reason: 'unconfigured' });
    }
    const forget = [MANAGED_VOICE_TOKEN_URL, 'DELETE', `Bearer ${TOKEN}`];
    await vi.waitFor(() => expect(requests()).toEqual([forget]));
    expect(JSON.parse(await readFile(file, 'utf8')).token).toBe(TOKEN);
    expect(broadcasts.at(-1)).toMatchObject({ configured: false, disconnectFailed: true });
    // The retry deletes at Hosted the token the failed clear left behind.
    expect(await host.handle({ op: 'disconnect' })).toMatchObject({ ok: true, configured: false });
    await vi.waitFor(() => expect(requests()).toEqual([forget, forget]));
    expect(await make().handle({ op: 'status' })).toEqual(idle(false));
  });

  it('obtains only a voice token, keeps codes out of status, and persists without a Burrow', async () => {
    vi.useFakeTimers();
    const begin = begun();
    fetchMock.mockResolvedValueOnce(Response.json(begin)).mockResolvedValueOnce(Response.json({ status: 'enabled', voiceToken: TOKEN }));
    expect(await host.handle({ op: 'beginEnrollment' })).toMatchObject({ ok: true, configured: false, enrollment: { status: 'waiting', verificationUrl: 'https://hosted.dormouse.sh/enroll?purpose=voice#7KQM-X4TD' } });
    await vi.advanceTimersByTimeAsync(1000);
    await vi.waitFor(async () => expect(await host.handle({ op: 'status' })).toEqual(idle(true)));
    expect(await make().handle({ op: 'status' })).toEqual(idle(true));
    expect(fetchMock.mock.calls.map(([, init]) => JSON.parse(init.body))).toEqual([
      { origin: DEFAULT_RELAY_ORIGIN, purpose: 'voice' },
      { deviceCode: begin.deviceCode, purpose: 'voice' },
    ]);
    expect(JSON.stringify(broadcasts)).not.toContain(begin.deviceCode);
    expect(JSON.stringify(broadcasts)).not.toContain(TOKEN);
  });

  it('refuses an older server before it can accidentally enroll remote control', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json({ ...begun(), purpose: undefined }));
    expect(await host.handle({ op: 'beginEnrollment' })).toMatchObject({ ok: false });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await host.handle({ op: 'status' })).toEqual(idle(false));
  });

  it('rejects a malformed voice token without saving or exposing it', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json(begun()))
      .mockResolvedValueOnce(Response.json({ status: 'enabled', voiceToken: 'sk-nope' }));
    await host.handle({ op: 'beginEnrollment' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await host.handle({ op: 'status' })).toMatchObject({ configured: false, enrollment: { status: 'ended' } });
    expect(await make().handle({ op: 'status' })).toEqual(idle(false));
    expect(JSON.stringify(broadcasts)).not.toContain('sk-nope');
  });

  it('reports a non-entitlement 403 without blaming the plan or exposing the body', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json(begun()))
      .mockResolvedValueOnce(Response.json({ error: 'forbidden', voiceToken: TOKEN }, { status: 403 }));
    await host.handle({ op: 'beginEnrollment' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(await host.handle({ op: 'status' })).toMatchObject({ configured: false, enrollment: { status: 'ended', message: 'Hosted refused managed-voice approval (HTTP 403).' } });
    expect(JSON.stringify(broadcasts)).not.toContain(TOKEN);
  });

  it('slows down after a 429 and enables voice after a transport retry', async () => {
    vi.useFakeTimers();
    fetchMock.mockResolvedValueOnce(Response.json(begun()))
      .mockResolvedValueOnce(new Response('', { status: 429 }))
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(Response.json({ status: 'enabled', voiceToken: TOKEN }));
    await host.handle({ op: 'beginEnrollment' });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(5999);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(6000);
    await vi.waitFor(async () => expect(await host.handle({ op: 'status' })).toEqual(idle(true)));
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });

  it('canceling a pending approval prevents a late token from enabling voice', async () => {
    vi.useFakeTimers();
    let answer!: (response: Response) => void;
    fetchMock.mockResolvedValueOnce(Response.json(begun())).mockImplementationOnce(() => new Promise<Response>((resolve) => { answer = resolve; }));
    await host.handle({ op: 'beginEnrollment' });
    await vi.advanceTimersByTimeAsync(1000);
    await host.handle({ op: 'cancelEnrollment' });
    answer(Response.json({ status: 'enabled', voiceToken: TOKEN }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(await host.handle({ op: 'status' })).toEqual(idle(false));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('disconnect during the saving notification cannot re-enable a late approval', async () => {
    vi.useFakeTimers();
    let disconnect: Promise<unknown> | undefined;
    host = createManagedVoiceHost({
      store: fileManagedVoiceStore(dir),
      onStatus: (status) => {
        broadcasts.push(status);
        if (status.enrollment?.status === 'saving') disconnect = host.handle({ op: 'disconnect' });
      },
      fetch: fetchMock as unknown as typeof fetch,
      relay: { origin: DEFAULT_RELAY_ORIGIN, mode: 'hosted' },
      networkAllowed: async () => true,
    });
    fetchMock.mockResolvedValueOnce(Response.json(begun())).mockResolvedValueOnce(Response.json({ status: 'enabled', voiceToken: TOKEN }));
    await host.handle({ op: 'beginEnrollment' });
    await vi.advanceTimersByTimeAsync(1000);
    await disconnect;
    expect(await host.handle({ op: 'status' })).toEqual(idle(false));
    expect(await make().handle({ op: 'status' })).toEqual(idle(false));
  });

  it('stops approval polling when the network policy changes to Nowhere', async () => {
    vi.useFakeTimers();
    let allowed = true;
    host = make({ networkAllowed: async () => allowed });
    fetchMock.mockResolvedValueOnce(Response.json(begun()));
    await host.handle({ op: 'beginEnrollment' });
    allowed = false;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetchMock).toHaveBeenCalledOnce();
    expect(await host.handle({ op: 'status' })).toMatchObject({ configured: false, enrollment: { status: 'ended', message: 'Network is set to Nowhere.' } });
  });
});

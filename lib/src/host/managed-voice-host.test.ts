import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedVoiceHost,
  MAX_AUDIO_BYTES,
  MANAGED_VOICE_FILE,
} from './managed-voice-host';
import { DEFAULT_MANAGED_VOICE_ID } from '../lib/platform/managed-voice-types';
import { DEFAULT_RELAY_ORIGIN } from './relay-origin';

/**
 * A fixed origin, never the relay origin (`docs/specs/relay.md` → "Relay
 * origin"): changing it changes where every shipped binary sends the token.
 */
const MANAGED_VOICE_SPEAK_URL = 'https://voice.dormouse.sh/api/voice/speak';

/** The next `readFile` fails with this, once: a Windows antivirus lock, say. */
const readFault = vi.hoisted(() => ({ next: null as NodeJS.ErrnoException | null }));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
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
    stateDir: 'stateDir' in options ? options.stateDir : dir,
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
  await rm(dir, { recursive: true, force: true });
});

const audioResponse = () => new Response(new Uint8Array([9, 8, 7]), {
  status: 200, headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
});

describe('configuration', () => {
  it('reports and broadcasts configured without ever carrying the token', async () => {
    expect(await host.handle({ op: 'status' })).toEqual({ configured: false, voiceId: DEFAULT_MANAGED_VOICE_ID });
    const result = await host.handle({ op: 'configure', update: { token: `  ${TOKEN}\n` } });
    expect(result).toEqual({ ok: true, configured: true, voiceId: DEFAULT_MANAGED_VOICE_ID });
    expect(broadcasts).toEqual([{ configured: true, voiceId: DEFAULT_MANAGED_VOICE_ID }]);
    expect(JSON.stringify([result, broadcasts])).not.toContain(TOKEN);
    expect(JSON.stringify(await host.handle({ op: 'status' }))).not.toContain(TOKEN);
  });

  it('keeps both of two edits sent at once', async () => {
    await Promise.all([
      host.handle({ op: 'configure', update: { token: TOKEN } }),
      host.handle({ op: 'configure', update: { voiceId: 'abc123' } }),
    ]);
    expect(JSON.parse(await readFile(join(dir, MANAGED_VOICE_FILE), 'utf8'))).toEqual({ token: TOKEN, voiceId: 'abc123' });
    expect(broadcasts.at(-1)).toEqual({ configured: true, voiceId: 'abc123' });
  });

  it('persists owner-only and survives a restart', async () => {
    await host.handle({ op: 'configure', update: { token: TOKEN, voiceId: 'abc123' } });
    const file = join(dir, MANAGED_VOICE_FILE);
    if (process.platform !== 'win32') expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: TOKEN, voiceId: 'abc123' });
    expect(await make().handle({ op: 'status' })).toEqual({ configured: true, voiceId: 'abc123' });
  });

  it('refuses malformed tokens and voice ids without storing them', async () => {
    expect(await host.handle({ op: 'configure', update: { token: 'sk-nope' } })).toEqual({ ok: false, reason: 'invalid-token' });
    expect(await host.handle({ op: 'configure', update: { voiceId: '../x' } })).toEqual({ ok: false, reason: 'invalid-voice' });
    expect(await host.handle({ op: 'status' })).toEqual({ configured: false, voiceId: DEFAULT_MANAGED_VOICE_ID });
    expect(broadcasts).toEqual([]);
  });

  it('clears the token', async () => {
    await host.handle({ op: 'configure', update: { token: TOKEN } });
    expect(await host.handle({ op: 'configure', update: { token: null } })).toMatchObject({ configured: false });
    expect(JSON.parse(await readFile(join(dir, MANAGED_VOICE_FILE), 'utf8')).token).toBeNull();
  });

  it('treats a corrupt or hand-edited file as unconfigured', async () => {
    await writeFile(join(dir, MANAGED_VOICE_FILE), JSON.stringify({ token: 'dmv_short', voiceId: 7 }));
    expect(await make().handle({ op: 'status' })).toEqual({ configured: false, voiceId: DEFAULT_MANAGED_VOICE_ID });
  });

  it('keeps a saved token through a read error, and reads again next time', async () => {
    await host.handle({ op: 'configure', update: { token: TOKEN } });
    const file = join(dir, MANAGED_VOICE_FILE);
    const restarted = make();
    readFault.next = Object.assign(new Error('EBUSY: resource busy or locked'), { code: 'EBUSY' });
    expect(await restarted.handle({ op: 'configure', update: { voiceId: 'abc123' } }))
      .toEqual({ ok: false, reason: 'unavailable' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: TOKEN, voiceId: DEFAULT_MANAGED_VOICE_ID });

    expect(await restarted.handle({ op: 'configure', update: { voiceId: 'abc123' } }))
      .toEqual({ ok: true, configured: true, voiceId: 'abc123' });
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual({ token: TOKEN, voiceId: 'abc123' });
  });

  it('refuses to hold a token with nowhere owner-only to keep it', async () => {
    expect(await make({ stateDir: undefined }).handle({ op: 'configure', update: { token: TOKEN } }))
      .toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('speak', () => {
  beforeEach(async () => {
    await host.handle({ op: 'configure', update: { token: TOKEN } });
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
    await host.handle({ op: 'configure', update: { token: null } });
    expect(await host.handle({ op: 'speak', text: 'x' })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
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

  it('refuses empty or over-long text', async () => {
    expect(await host.handle({ op: 'speak', text: '   ' })).toEqual({ ok: false, reason: 'bad-request' });
    expect(await host.handle({ op: 'speak', text: 'x'.repeat(201) })).toEqual({ ok: false, reason: 'bad-request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('the build it runs in', () => {
  it('speaks to the voice origin from any Hosted build, a dev build’s local Hosted included', async () => {
    const local = createManagedVoiceHost({
      stateDir: dir,
      onStatus: () => {},
      fetch: fetchMock as unknown as typeof fetch,
      relay: { origin: 'http://localhost:8787', mode: 'hosted' },
      networkAllowed: async () => true,
    });
    await local.handle({ op: 'configure', update: { token: TOKEN } });
    fetchMock.mockResolvedValue(audioResponse());

    expect(await local.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: true });
    expect(fetchMock.mock.calls[0]![0]).toBe(MANAGED_VOICE_SPEAK_URL);
  });

  it('sends nothing from a self-host build, whatever a Hosted build saved', async () => {
    // A token saved by a Hosted build on this machine is still on disk; a
    // self-host build reaches nothing of Dormouse's (docs/specs/relay.md →
    // "Relay origin"), so it reads none of it.
    await host.handle({ op: 'configure', update: { token: TOKEN } });
    const selfHost = createManagedVoiceHost({
      stateDir: dir,
      onStatus: (status) => void broadcasts.push(status),
      fetch: fetchMock as unknown as typeof fetch,
      relay: { origin: 'https://relay.example.ts.net', mode: 'self-host' },
      networkAllowed: async () => true,
    });
    broadcasts = [];

    expect(await selfHost.handle({ op: 'status' })).toEqual({
      configured: false,
      voiceId: DEFAULT_MANAGED_VOICE_ID,
    });
    expect(await selfHost.handle({ op: 'configure', update: { voiceId: 'abc123' } })).toEqual({
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
    // of its own. Saving a token is local, so it still works.
    let allowed = false;
    const gated = make({ networkAllowed: async () => allowed });
    expect(await gated.handle({ op: 'configure', update: { token: TOKEN } })).toMatchObject({ ok: true });
    fetchMock.mockResolvedValue(audioResponse());

    expect(await gated.handle({ op: 'speak', text: 'build finished' })).toEqual({
      ok: false,
      reason: 'network-off',
    });
    expect(fetchMock).not.toHaveBeenCalled();

    allowed = true;
    expect(await gated.handle({ op: 'speak', text: 'build finished' })).toMatchObject({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

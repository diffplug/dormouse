import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createManagedVoiceHost, MANAGED_VOICE_FILE, type ManagedVoiceHost } from './managed-voice-host';
import { DEFAULT_MANAGED_VOICE_ID, MANAGED_VOICE_SPEAK_URL } from '../lib/platform/managed-voice-types';

/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Spoken alarms"):
 * the token stays here, the request is shaped per the wire contract, and every
 * failure becomes a kind the renderer falls back on.
 */

const TOKEN = `dmv_${'A'.repeat(43)}`;
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
let host: ManagedVoiceHost;

function make(options: { timeoutMs?: number; stateDir?: string } = {}): ManagedVoiceHost {
  return createManagedVoiceHost({
    stateDir: 'stateDir' in options ? options.stateDir : dir,
    fetch: fetchMock as unknown as typeof fetch,
    timeoutMs: options.timeoutMs,
  });
}

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'managed-voice-'));
  fetchMock = vi.fn();
  host = make();
});

afterEach(async () => {
  host.dispose();
  await rm(dir, { recursive: true, force: true });
});

const audioResponse = () => new Response(new Uint8Array([9, 8, 7]), {
  status: 200, headers: { 'content-type': 'audio/mpeg', 'cache-control': 'no-store' },
});

describe('configuration', () => {
  it('reports configured without ever returning the token', async () => {
    expect(await host.handle({ op: 'status' })).toEqual({ configured: false, voiceId: DEFAULT_MANAGED_VOICE_ID });
    const result = await host.handle({ op: 'configure', update: { token: `  ${TOKEN}\n` } });
    expect(result).toEqual({ ok: true, configured: true, voiceId: DEFAULT_MANAGED_VOICE_ID });
    expect(JSON.stringify(result)).not.toContain(TOKEN);
    expect(JSON.stringify(await host.handle({ op: 'status' }))).not.toContain(TOKEN);
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
    const result = await host.handle({ op: 'speak', speakId: 's1', text: 'build finished' });
    expect(result).toEqual({ ok: true, mime: 'audio/mpeg', audioBase64: Buffer.from([9, 8, 7]).toString('base64') });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe(MANAGED_VOICE_SPEAK_URL);
    expect(init.method).toBe('POST');
    expect(init.redirect).toBe('error');
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.parse(init.body as string)).toEqual({ text: 'build finished', voiceId: DEFAULT_MANAGED_VOICE_ID });
  });

  it('answers unconfigured without a request', async () => {
    await host.handle({ op: 'configure', update: { token: null } });
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    [400, 'bad-request'], [401, 'unauthorized'], [403, 'forbidden'],
    [429, 'rate-limited'], [502, 'upstream'], [500, 'http'],
  ])('maps HTTP %i to %s', async (status, reason) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'no' }), { status }));
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason });
  });

  it('refuses a non-audio success body', async () => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200, headers: { 'content-type': 'text/html' } }));
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason: 'http' });
  });

  it('reports a network failure', async () => {
    fetchMock.mockRejectedValue(new TypeError('getaddrinfo ENOTFOUND hosted.dormouse.sh'));
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason: 'network' });
  });

  const hangingFetch = () => fetchMock.mockImplementation((_url: string, init: RequestInit) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    }));

  it('aborts the request on cancel', async () => {
    hangingFetch();
    const pending = host.handle({ op: 'speak', speakId: 's1', text: 'x' });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled());
    await host.handle({ op: 'cancel', speakId: 's1' });
    expect(await pending).toEqual({ ok: false, reason: 'cancelled' });
  });

  it('honours a cancel that overtook its speak', async () => {
    await host.handle({ op: 'cancel', speakId: 's1' });
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason: 'cancelled' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('times out a hung request', async () => {
    hangingFetch();
    const quick = make({ timeoutMs: 5 });
    expect(await quick.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason: 'timeout' });
  });

  it('refuses empty or over-long text', async () => {
    expect(await host.handle({ op: 'speak', speakId: 's1', text: '   ' })).toEqual({ ok: false, reason: 'bad-request' });
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x'.repeat(201) })).toEqual({ ok: false, reason: 'bad-request' });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

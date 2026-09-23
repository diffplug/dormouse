import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createManagedVoiceHost,
  MAX_AUDIO_BYTES,
  MANAGED_VOICE_FILE,
  resolveManagedVoiceSpeakUrl,
  type ManagedVoiceHost,
} from './managed-voice-host';
import { DEFAULT_MANAGED_VOICE_ID } from '../lib/platform/managed-voice-types';

const MANAGED_VOICE_SPEAK_URL = 'https://hosted.dormouse.sh/api/voice/speak';

/**
 * The host half of managed voice (`docs/specs/alert.md` -> "Spoken alarms"):
 * the token stays here, the request is shaped per the wire contract, and every
 * failure becomes a kind the renderer falls back on.
 */

const TOKEN = `dmv_${'A'.repeat(43)}`;
let dir: string;
let fetchMock: ReturnType<typeof vi.fn>;
let host: ManagedVoiceHost;

function make(options: { timeoutMs?: number; stateDir?: string; speakOrigin?: string } = {}): ManagedVoiceHost {
  return createManagedVoiceHost({
    stateDir: 'stateDir' in options ? options.stateDir : dir,
    fetch: fetchMock as unknown as typeof fetch,
    timeoutMs: options.timeoutMs,
    speakOrigin: options.speakOrigin,
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
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason: 'unconfigured' });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([400, 401, 403, 429, 502])('reports HTTP %i as a failure', async (status) => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ message: 'no' }), { status }));
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toEqual({ ok: false, reason: `HTTP ${status}` });
  });

  it.each(['text/html', 'audio/wav'])('refuses a %s success body', async (type) => {
    fetchMock.mockResolvedValue(new Response('<html>', { status: 200, headers: { 'content-type': type } }));
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toMatchObject({ ok: false });
  });

  it('refuses audio over the size cap', async () => {
    fetchMock.mockResolvedValue(new Response(new Uint8Array(MAX_AUDIO_BYTES + 1), {
      status: 200, headers: { 'content-type': 'audio/mpeg' },
    }));
    expect(await host.handle({ op: 'speak', speakId: 's1', text: 'x' })).toMatchObject({ ok: false });
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
    expect(await host.handle({ op: 'cancel', speakId: 's1' })).toEqual({ ok: true });
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

describe('dev Hosted origin override', () => {
  it.each([
    ['http://127.0.0.1:5199', 'http://127.0.0.1:5199/api/voice/speak'],
    ['http://127.0.0.1:5199/', 'http://127.0.0.1:5199/api/voice/speak'],
    ['http://localhost:5199', 'http://localhost:5199/api/voice/speak'],
    ['http://[::1]:5199', 'http://[::1]:5199/api/voice/speak'],
  ])('accepts the loopback origin %s', (override, expected) => {
    expect(resolveManagedVoiceSpeakUrl(override)).toBe(expected);
  });

  it.each([
    undefined, '', 'not a url', 'https://127.0.0.1:5199', 'http://hosted.dormouse.sh',
    'http://evil.example', 'http://127.0.0.1.evil.example:5199', 'http://192.168.1.2:5199',
    'http://0.0.0.0:5199', 'http://user:pw@127.0.0.1:5199', 'http://127.0.0.1:5199/api',
    'http://127.0.0.1:5199/?x=1', 'file:///etc/passwd', 'ws://127.0.0.1:5199',
  ])('falls back to production for %s', (override) => {
    expect(resolveManagedVoiceSpeakUrl(override)).toBe(MANAGED_VOICE_SPEAK_URL);
  });

  it('sends the speak request to the accepted origin', async () => {
    const dev = make({ speakOrigin: 'http://127.0.0.1:5199' });
    await dev.handle({ op: 'configure', update: { token: TOKEN } });
    fetchMock.mockResolvedValue(audioResponse());
    await dev.handle({ op: 'speak', speakId: 's1', text: 'x' });
    expect(fetchMock.mock.calls[0][0]).toBe('http://127.0.0.1:5199/api/voice/speak');
  });

  it('never sends the token to a rejected override', async () => {
    const dev = make({ speakOrigin: 'http://evil.example' });
    await dev.handle({ op: 'configure', update: { token: TOKEN } });
    fetchMock.mockResolvedValue(audioResponse());
    await dev.handle({ op: 'speak', speakId: 's1', text: 'x' });
    expect(fetchMock.mock.calls[0][0]).toBe(MANAGED_VOICE_SPEAK_URL);
  });
});

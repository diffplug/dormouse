/**
 * The frame tunnel against a fake {@link BurrowFrameHost}: what a Client is
 * answered, in what order, and what the flow window holds back. The Node host
 * against a real proxy is `lib/src/host/remote/frame-host.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  FRAME_CHUNK_BYTES,
  FRAME_EVENTS,
  FRAME_FLOW_WINDOW_BYTES,
  FRAME_METHODS,
  MAX_FRAMES_PER_SESSION,
  fromBase64Url,
  toBase64Url,
  type RemoteEventMsg,
  type RemoteRequest,
  type RemoteResponse,
} from 'remote-lib-common';
import type {
  BurrowFrameHost,
  FrameHttpInit,
  FrameHttpSink,
  FrameOpenOptions,
  FrameSocketInit,
  FrameSocketSink,
  FrameUpstream,
} from './burrow-frame-host';
import type { BurrowSurfaceProvider } from './burrow-surface-provider';
import { FrameTunnel, OWNER_SILENCE_LIMIT_MS } from './frame-tunnel';

type Sent = RemoteResponse | RemoteEventMsg;

class FakeExchange {
  readonly writes: Array<[string, boolean]> = [];
  paused = false;
  aborted = false;
  constructor(readonly init: FrameHttpInit, readonly sink: FrameHttpSink) {}
  write(chunk: Uint8Array, end: boolean): Promise<void> {
    this.writes.push([new TextDecoder().decode(chunk), end]);
    return Promise.resolve();
  }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  abort() { this.aborted = true; }
}

class FakeSocket {
  readonly sent: Array<[string, boolean]> = [];
  paused = false;
  terminated = false;
  closed: [number | undefined, string | undefined] | null = null;
  constructor(readonly init: FrameSocketInit, readonly sink: FrameSocketSink) {}
  send(data: Uint8Array, binary: boolean): Promise<void> {
    this.sent.push([new TextDecoder().decode(data), binary]);
    return Promise.resolve();
  }
  close(code?: number, reason?: string) { this.closed = [code, reason]; }
  pause() { this.paused = true; }
  resume() { this.paused = false; }
  terminate() { this.terminated = true; }
}

class FakeUpstream implements FrameUpstream {
  readonly path = '/app/?x=1#top';
  readonly exchanges: FakeExchange[] = [];
  readonly sockets: FakeSocket[] = [];
  closed = false;
  request(init: FrameHttpInit, sink: FrameHttpSink) {
    const exchange = new FakeExchange(init, sink);
    this.exchanges.push(exchange);
    return exchange;
  }
  openSocket(init: FrameSocketInit, sink: FrameSocketSink) {
    const socket = new FakeSocket(init, sink);
    this.sockets.push(socket);
    return socket;
  }
  close() { this.closed = true; }
}

class FakeHost implements BurrowFrameHost {
  readonly opened: Array<[string, FrameOpenOptions]> = [];
  readonly upstreams: FakeUpstream[] = [];
  refuse: string | null = null;
  /** Held until released, as a slow grant is. */
  hold: Promise<void> | null = null;
  async open(url: string, options: FrameOpenOptions) {
    this.opened.push([url, options]);
    await this.hold;
    if (this.refuse) return { refused: this.refuse };
    const upstream = new FakeUpstream();
    this.upstreams.push(upstream);
    return upstream;
  }
}

interface EmbeddedPage { url: string; title?: string }

function fakeProvider(pages: Map<string, EmbeddedPage>) {
  const watchers = new Set<() => void>();
  const provider = {
    resolveBrowser: vi.fn(async (surfaceId: string) => pages.get(surfaceId)?.url ?? null),
    collectDirectory: vi.fn(async () => [...pages].map(([surfaceId, { url }]) => ({ surfaceId, browser: { render: 'iframe', url } }))),
    watchDirectory: vi.fn((onChange: () => void) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    }),
  } as unknown as BurrowSurfaceProvider;
  return { provider, watchers, notify: () => watchers.forEach((watcher) => watcher()) };
}

function setup({ isDirect = () => true }: { isDirect?: () => boolean } = {}) {
  const pages = new Map<string, EmbeddedPage>([['surface:1', { url: 'http://localhost:5173/app/?x=1#top', title: 'App' }]]);
  const { provider, watchers, notify } = fakeProvider(pages);
  const host = new FakeHost();
  const sent: Sent[] = [];
  const tunnel = new FrameTunnel({
    host,
    isDirect,
    provider,
    leaseOwner: 'remote:holder',
    directoryWatched: () => false,
    ok: (request, result) => sent.push({ requestId: request.requestId, ok: true, result }),
    fail: (request, error) => sent.push({ requestId: request.requestId, ok: false, error }),
    event: (subId, event, data) => sent.push({ subId, event, data }),
  });
  let seq = 0;
  const call = (method: string, params: unknown, requestId = `r${++seq}`): string => {
    tunnel.handle({ requestId, method, params } satisfies RemoteRequest);
    return requestId;
  };
  const answer = (requestId: string) => sent.find((m): m is RemoteResponse => 'requestId' in m && m.requestId === requestId);
  const events = (subId: string, event?: string) =>
    sent.filter((m): m is RemoteEventMsg => 'subId' in m && m.subId === subId && (!event || m.event === event));
  const open = async (surfaceId = 'surface:1') => {
    const id = call(FRAME_METHODS.frameOpen, { ...OPEN, surfaceId });
    await flush();
    return id;
  };
  return { tunnel, host, pages, provider, watchers, notify, sent, call, answer, events, open };
}

async function flush(): Promise<void> {
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
}

const OPEN = {
  surfaceId: 'surface:1',
  pageOrigin: 'http://localhost:5173',
  frameOrigin: 'https://f.example',
  embedderOrigins: ['https://pocket.example'],
};
const GET = { method: 'GET', path: '/', headers: [['accept', 'text/html']], end: true };

afterEach(() => {
  vi.useRealTimers();
});

describe('frame.open', () => {
  it('refuses a page no longer at the origin the Client named its frame origin for', async () => {
    const t = setup();
    t.pages.set('surface:1', { url: 'http://localhost:9999/' });
    const id = await t.open();
    expect(t.answer(id)).toMatchObject({ ok: false, error: 'the page moved: surface:1' });
    expect(t.host.upstreams).toHaveLength(0);
    const unnamed = t.call(FRAME_METHODS.frameOpen, { ...OPEN, pageOrigin: undefined });
    expect(t.answer(unnamed)).toMatchObject({ ok: false, error: 'invalid frame.open: origins' });
  });

  it('refuses a session the direct path does not carry, until it does', async () => {
    let direct = false;
    const t = setup({ isDirect: () => direct });
    const refused = await t.open();
    expect(t.answer(refused)).toMatchObject({ ok: false, error: 'a frame needs a direct connection' });
    expect(t.provider.resolveBrowser).not.toHaveBeenCalled();

    direct = true;
    expect(t.answer(await t.open())).toMatchObject({ ok: true });
  });

  it('opens the surface\'s own page under the session\'s lease and answers the framed path', async () => {
    const t = setup();
    const id = await t.open();
    expect(t.host.opened).toEqual([['http://localhost:5173/app/?x=1#top', {
      frameOrigin: 'https://f.example',
      embedderOrigins: ['https://pocket.example'],
      lease: { owner: 'remote:holder', id: 'f1' },
    }]]);
    expect(t.answer(id)).toEqual({
      requestId: id,
      ok: true,
      result: { path: '/app/?x=1#top' },
    });
  });

  it('fails for a surface embedding no page, and for a refused grant', async () => {
    const t = setup();
    const none = await t.open('surface:9');
    expect(t.answer(none)).toMatchObject({ ok: false, error: 'no embedded page: surface:9' });
    t.host.refuse = 'link-local / metadata addresses are refused';
    const refused = await t.open();
    expect(t.answer(refused)).toMatchObject({ ok: false, error: 'frame refused: link-local / metadata addresses are refused' });
  });

  it('caps the frames one session holds', async () => {
    const t = setup();
    for (let i = 0; i < MAX_FRAMES_PER_SESSION; i += 1) await t.open();
    const over = await t.open();
    expect(t.answer(over)).toMatchObject({ ok: false, error: 'too many frames are open' });
    expect(t.host.opened).toHaveLength(MAX_FRAMES_PER_SESSION);
  });

  it('closes a frame whose surface stops embedding its page\'s origin, telling the Client', async () => {
    vi.useFakeTimers();
    const t = setup();
    const id = t.call(FRAME_METHODS.frameOpen, OPEN);
    await vi.advanceTimersByTimeAsync(0);
    // Another path on the same origin keeps it.
    t.pages.set('surface:1', { url: 'http://localhost:5173/other' });
    t.notify();
    await vi.advanceTimersByTimeAsync(200);
    expect(t.host.upstreams[0]!.closed).toBe(false);
    t.pages.set('surface:1', { url: 'http://localhost:9999/' });
    t.notify();
    await vi.advanceTimersByTimeAsync(200);
    expect(t.host.upstreams[0]!.closed).toBe(true);
    expect(t.events(id, FRAME_EVENTS.frameClosed)).toEqual([{ subId: id, event: FRAME_EVENTS.frameClosed, data: { reason: 'surface-gone' } }]);
    expect(t.watchers.size).toBe(0);
  });

  it('keeps a frame a listing wrongly says is gone, asking the owner first', async () => {
    const t = setup();
    const id = await t.open();
    // An older snapshot, and one a timeout left empty.
    t.tunnel.revalidate([{ surfaceId: 'surface:1', browser: { render: 'iframe', url: 'http://localhost:9999/' } } as never]);
    t.tunnel.revalidate([]);
    await flush();
    expect(t.host.upstreams[0]!.closed).toBe(false);
    expect(t.events(id, FRAME_EVENTS.frameClosed)).toEqual([]);
    t.pages.delete('surface:1');
    t.tunnel.revalidate([]);
    await flush();
    expect(t.host.upstreams[0]!.closed).toBe(true);
    expect(t.events(id, FRAME_EVENTS.frameClosed)).toHaveLength(1);
  });

  it('keeps a frame through its owner\'s silence, for a time', async () => {
    vi.useFakeTimers();
    const t = setup();
    const id = t.call(FRAME_METHODS.frameOpen, OPEN);
    await vi.advanceTimersByTimeAsync(0);
    t.provider.resolveBrowser = vi.fn(async () => { throw new Error('the surface owner did not answer'); });
    t.tunnel.revalidate([]);
    await vi.advanceTimersByTimeAsync(OWNER_SILENCE_LIMIT_MS - 1_000);
    expect(t.host.upstreams[0]!.closed).toBe(false);
    expect((t.provider.resolveBrowser as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThan(10);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(t.host.upstreams[0]!.closed).toBe(true);
    expect(t.events(id, FRAME_EVENTS.frameClosed)).toHaveLength(1);
  });

  it('starts the silence over once the owner answers', async () => {
    vi.useFakeTimers();
    const t = setup();
    t.call(FRAME_METHODS.frameOpen, OPEN);
    await vi.advanceTimersByTimeAsync(0);
    const answer = t.provider.resolveBrowser;
    t.provider.resolveBrowser = vi.fn(async () => { throw new Error('silent'); });
    t.tunnel.revalidate([]);
    await vi.advanceTimersByTimeAsync(OWNER_SILENCE_LIMIT_MS - 1_000);
    t.provider.resolveBrowser = answer;
    await vi.advanceTimersByTimeAsync(1_000);
    t.provider.resolveBrowser = vi.fn(async () => { throw new Error('silent'); });
    t.tunnel.revalidate([]);
    await vi.advanceTimersByTimeAsync(OWNER_SILENCE_LIMIT_MS - 1_000);
    expect(t.host.upstreams[0]!.closed).toBe(false);
  });

  it('closes a frame whose page went while its grant was being minted', async () => {
    vi.useFakeTimers();
    const t = setup();
    let release = () => {};
    t.host.hold = new Promise((resolve) => { release = resolve; });
    const id = t.call(FRAME_METHODS.frameOpen, OPEN);
    await vi.advanceTimersByTimeAsync(0);
    expect(t.host.opened).toHaveLength(1);
    // Nothing is watching this frame yet, so no notice of it comes.
    t.pages.clear();
    release();
    await vi.advanceTimersByTimeAsync(200);
    expect(t.host.upstreams[0]!.closed).toBe(true);
    expect(t.events(id, FRAME_EVENTS.frameClosed)).toHaveLength(1);
  });

  it('frame.close ends the grant and fails what is still pending in it', async () => {
    const t = setup();
    const frameId = await t.open();
    const req = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    const close = t.call(FRAME_METHODS.frameClose, { frameId });
    expect(t.answer(close)).toMatchObject({ ok: true });
    expect(t.host.upstreams[0]!.closed).toBe(true);
    expect(t.host.upstreams[0]!.exchanges[0]!.aborted).toBe(true);
    expect(t.answer(req)).toMatchObject({ ok: false, error: 'request cancelled' });
  });
});

describe('http', () => {
  it('answers the head, then streams body and end under the request id', async () => {
    const t = setup();
    const frameId = await t.open();
    const id = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId, destination: 'iframe' });
    const exchange = t.host.upstreams[0]!.exchanges[0]!;
    expect(exchange.init).toEqual({ method: 'GET', path: '/', headers: [['accept', 'text/html']], destination: 'iframe' });
    expect(exchange.writes).toEqual([['', true]]);
    exchange.sink.onHead(200, 'OK', [['content-type', 'text/html']]);
    exchange.sink.onBody(new TextEncoder().encode('<p>hi</p>'));
    exchange.sink.onEnd();
    expect(t.answer(id)).toEqual({ requestId: id, ok: true, result: { status: 200, statusText: 'OK', headers: [['content-type', 'text/html']] } });
    const stream = t.events(id);
    expect(stream.map((m) => m.event)).toEqual([FRAME_EVENTS.httpBody, FRAME_EVENTS.httpEnd]);
    expect(new TextDecoder().decode(fromBase64Url((stream[0]!.data as { bytes: string }).bytes))).toBe('<p>hi</p>');
  });

  it('streams a request body through http.write, answering each once the upstream took it', async () => {
    const t = setup();
    const frameId = await t.open();
    const id = t.call(FRAME_METHODS.httpRequest, { frameId, method: 'POST', path: '/save', headers: [], end: false });
    t.call(FRAME_METHODS.httpWrite, { exchangeId: id, bytes: toBase64Url(new TextEncoder().encode('ab')), end: false });
    const write = t.call(FRAME_METHODS.httpWrite, { exchangeId: id, bytes: toBase64Url(new TextEncoder().encode('cd')), end: true });
    await flush();
    expect(t.host.upstreams[0]!.exchanges[0]!.writes).toEqual([['ab', false], ['cd', true]]);
    expect(t.answer(write)).toMatchObject({ ok: true });
    const late = t.call(FRAME_METHODS.httpWrite, { exchangeId: id, bytes: '', end: true });
    expect(t.answer(late)).toMatchObject({ ok: false, error: 'no such request body' });
  });

  it('fails an upstream error before the head, and streams one after it', async () => {
    const t = setup();
    const frameId = await t.open();
    const before = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    t.host.upstreams[0]!.exchanges[0]!.sink.onError('ECONNRESET');
    expect(t.answer(before)).toMatchObject({ ok: false, error: 'upstream failed: ECONNRESET' });
    const after = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    const exchange = t.host.upstreams[0]!.exchanges[1]!;
    exchange.sink.onHead(200, 'OK', []);
    exchange.sink.onError('socket hang up');
    expect(t.events(after, FRAME_EVENTS.httpError)).toMatchObject([{ data: { message: 'upstream failed: socket hang up' } }]);
  });

  it('refuses malformed requests before they reach the upstream', async () => {
    const t = setup();
    const frameId = await t.open();
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ method: 'CONNECT' }, 'method'],
      [{ method: 'G ET' }, 'method'],
      [{ path: 'http://evil.example/' }, 'path'],
      [{ path: '/a b' }, 'path'],
      [{ headers: [['x-a', 'b\r\nx-c: d']] }, 'headers'],
      [{ headers: [['bad name', 'v']] }, 'headers'],
      [{ destination: 'Document' }, 'destination'],
    ];
    for (const [patch, field] of cases) {
      const id = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId, ...patch });
      expect(t.answer(id)).toMatchObject({ ok: false, error: `invalid http.request: ${field}` });
    }
    expect(t.host.upstreams[0]!.exchanges).toHaveLength(0);
    const nowhere = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId: 'nope' });
    expect(t.answer(nowhere)).toMatchObject({ ok: false, error: 'no such frame' });
  });

  it('http.cancel aborts the exchange, drops its queued events, and fails an unanswered request', async () => {
    const t = setup();
    const frameId = await t.open();
    const id = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    t.call(FRAME_METHODS.httpCancel, { exchangeId: id });
    expect(t.host.upstreams[0]!.exchanges[0]!.aborted).toBe(true);
    expect(t.answer(id)).toMatchObject({ ok: false, error: 'request cancelled' });
  });
});

describe('the flow window', () => {
  describe('a finished exchange with events still behind the window', () => {
    async function finishedBehindWindow(t: ReturnType<typeof setup>) {
      const frameId = await t.open();
      const id = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
      const exchange = t.host.upstreams[0]!.exchanges[0]!;
      exchange.sink.onHead(200, 'OK', []);
      exchange.sink.onBody(new Uint8Array(FRAME_FLOW_WINDOW_BYTES * 2));
      exchange.sink.onEnd();
      return { frameId, id };
    }
    const sentBytes = (t: ReturnType<typeof setup>, id: string) => t.events(id, FRAME_EVENTS.httpBody)
      .reduce((total, m) => total + fromBase64Url((m.data as { bytes: string }).bytes).length, 0);

    it('sends none of them past a cancel, which no Client would ever ack', async () => {
      const t = setup();
      const { id } = await finishedBehindWindow(t);
      const sent = sentBytes(t, id);
      t.call(FRAME_METHODS.httpCancel, { exchangeId: id });
      t.call(FRAME_METHODS.flowAck, { bytes: sent });
      expect(sentBytes(t, id)).toBe(sent);
      expect(t.events(id, FRAME_EVENTS.httpEnd)).toHaveLength(0);
    });

    it('sends none of them past its frame closing', async () => {
      const t = setup();
      const { frameId, id } = await finishedBehindWindow(t);
      const sent = sentBytes(t, id);
      t.call(FRAME_METHODS.frameClose, { frameId });
      t.call(FRAME_METHODS.flowAck, { bytes: sent });
      expect(sentBytes(t, id)).toBe(sent);
      expect(t.events(id, FRAME_EVENTS.httpEnd)).toHaveLength(0);
    });

    it('leaves another exchange\'s events alone', async () => {
      const t = setup();
      const { frameId, id } = await finishedBehindWindow(t);
      const other = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
      const second = t.host.upstreams[0]!.exchanges[1]!;
      second.sink.onHead(200, 'OK', []);
      second.sink.onEnd();
      const sent = sentBytes(t, id);
      t.call(FRAME_METHODS.httpCancel, { exchangeId: id });
      t.call(FRAME_METHODS.flowAck, { bytes: sent });
      expect(t.events(other, FRAME_EVENTS.httpEnd)).toHaveLength(1);
    });
  });

  it('holds body bytes past the window until acknowledged, pausing every source meanwhile', async () => {
    const t = setup();
    const frameId = await t.open();
    const id = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    const exchange = t.host.upstreams[0]!.exchanges[0]!;
    exchange.sink.onHead(200, 'OK', []);
    // Two windows' worth arrive before the Client acknowledges anything.
    exchange.sink.onBody(new Uint8Array(FRAME_FLOW_WINDOW_BYTES * 2));
    exchange.sink.onEnd();
    const sentBytes = () => t.events(id, FRAME_EVENTS.httpBody)
      .reduce((total, m) => total + fromBase64Url((m.data as { bytes: string }).bytes).length, 0);
    const first = sentBytes();
    expect(first).toBeLessThanOrEqual(FRAME_FLOW_WINDOW_BYTES);
    expect(first).toBeGreaterThan(FRAME_FLOW_WINDOW_BYTES - FRAME_CHUNK_BYTES);
    expect(exchange.paused).toBe(true);
    expect(t.events(id, FRAME_EVENTS.httpEnd)).toHaveLength(0);
    // Each ack releases what it frees, never more.
    let acked = 0;
    while (sentBytes() > acked) {
      const unacked = sentBytes() - acked;
      expect(unacked).toBeLessThanOrEqual(FRAME_FLOW_WINDOW_BYTES);
      acked += unacked;
      t.call(FRAME_METHODS.flowAck, { bytes: unacked });
    }
    expect(acked).toBe(FRAME_FLOW_WINDOW_BYTES * 2);
    // An emptied window starts the next exchange unpaused.
    t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    expect(t.host.upstreams[0]!.exchanges[1]!.paused).toBe(false);
    // The end waited behind its own body.
    expect(t.events(id).at(-1)!.event).toBe(FRAME_EVENTS.httpEnd);
    for (const m of t.events(id, FRAME_EVENTS.httpBody)) {
      expect(fromBase64Url((m.data as { bytes: string }).bytes).length).toBeLessThanOrEqual(FRAME_CHUNK_BYTES);
    }
  });

  it('lets a page that stopped reading hold its own exchange, not the session', async () => {
    const t = setup();
    const frameId = await t.open();
    const held = t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    t.call(FRAME_METHODS.httpRequest, { ...GET, frameId });
    const [stalled, other] = t.host.upstreams[0]!.exchanges;
    t.call(FRAME_METHODS.flowPause, { id: held, paused: true });
    expect(stalled!.paused).toBe(true);
    expect(other!.paused).toBe(false);

    // The window filling and emptying releases everything but the held one.
    other!.sink.onHead(200, 'OK', []);
    other!.sink.onBody(new Uint8Array(FRAME_FLOW_WINDOW_BYTES));
    expect(other!.paused).toBe(true);
    t.call(FRAME_METHODS.flowAck, { bytes: FRAME_FLOW_WINDOW_BYTES });
    t.call(FRAME_METHODS.flowAck, { bytes: FRAME_FLOW_WINDOW_BYTES });
    expect(other!.paused).toBe(false);
    expect(stalled!.paused).toBe(true);

    t.call(FRAME_METHODS.flowPause, { id: held, paused: false });
    expect(stalled!.paused).toBe(false);
    const gone = t.call(FRAME_METHODS.flowPause, { id: 'nope', paused: true });
    expect(t.answer(gone)).toMatchObject({ ok: true });
  });

  it('refuses a malformed ack', async () => {
    const t = setup();
    const id = t.call(FRAME_METHODS.flowAck, { bytes: -1 });
    expect(t.answer(id)).toMatchObject({ ok: false, error: 'invalid flow.ack' });
  });
});

describe('websockets', () => {
  it('answers the open, fragments large messages, and reassembles the Client\'s', async () => {
    const t = setup();
    const frameId = await t.open();
    const id = t.call(FRAME_METHODS.wsOpen, { frameId, path: '/hmr', protocols: ['vite-hmr'] });
    const socket = t.host.upstreams[0]!.sockets[0]!;
    expect(socket.init).toEqual({ path: '/hmr', protocols: ['vite-hmr'] });
    socket.sink.onOpen('vite-hmr', '');
    expect(t.answer(id)).toEqual({ requestId: id, ok: true, result: { protocol: 'vite-hmr', extensions: '' } });

    socket.sink.onMessage(new Uint8Array(FRAME_CHUNK_BYTES + 1), true);
    socket.sink.onMessage(new Uint8Array(0), false);
    expect(t.events(id, FRAME_EVENTS.wsMessage).map((m) => (m.data as { fin: boolean }).fin)).toEqual([false, true, true]);

    const part = (text: string, fin: boolean) =>
      t.call(FRAME_METHODS.wsSend, { socketId: id, data: toBase64Url(new TextEncoder().encode(text)), binary: false, fin });
    part('hel', false);
    part('lo', true);
    await flush();
    expect(socket.sent).toEqual([['hello', false]]);

    socket.sink.onClose(1000, 'bye');
    expect(t.events(id, FRAME_EVENTS.wsClosed)).toMatchObject([{ data: { code: 1000, reason: 'bye' } }]);
    const late = part('x', true);
    expect(t.answer(late)).toMatchObject({ ok: false, error: 'no such socket' });
  });

  it('fails the open when the upstream closes first, and refuses a reserved close code', async () => {
    const t = setup();
    const frameId = await t.open();
    const id = t.call(FRAME_METHODS.wsOpen, { frameId, path: '/' });
    t.host.upstreams[0]!.sockets[0]!.sink.onClose(1006, '');
    expect(t.answer(id)).toMatchObject({ ok: false, error: 'upstream refused the socket: 1006' });
    const bad = t.call(FRAME_METHODS.wsClose, { socketId: id, code: 1006 });
    expect(t.answer(bad)).toMatchObject({ ok: false, error: 'invalid ws.close: code' });
  });

  it('dispose ends every frame without answering anything more', async () => {
    const t = setup();
    const frameId = await t.open();
    t.call(FRAME_METHODS.wsOpen, { frameId, path: '/' });
    const before = t.sent.length;
    t.tunnel.dispose();
    expect(t.host.upstreams[0]!.closed).toBe(true);
    expect(t.host.upstreams[0]!.sockets[0]!.terminated).toBe(true);
    expect(t.sent.length).toBe(before);
  });
});

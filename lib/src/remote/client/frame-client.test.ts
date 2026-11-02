// @vitest-environment node
/**
 * The tunnel end to end, minus the crypto underneath it: a real `FrameClient`
 * over JSON to a real `RemoteApiSession`, through the real iframe proxy, to a
 * real upstream. What only this can show is that the two flow-control halves
 * agree: nothing wedges, whatever the page does.
 */

import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { WebSocketServer } from 'ws';
import {
  FRAME_CHUNK_BYTES,
  FRAME_EVENTS,
  FRAME_FLOW_MESSAGE_COST,
  FRAME_FLOW_WINDOW_BYTES,
  FRAME_METHODS,
  MAX_HTTP_EXCHANGES_PER_SESSION,
  fromBase64Url,
  toBase64Url,
  type RemoteEventMsg,
  type RemoteResponse,
} from 'remote-lib-common';
import { createIframeProxyUrl, isUpstreamOnThisMachine, releaseIframeProxyLease } from '../../host/iframe-proxy';
import { createBurrowFrameHost } from '../../host/remote/frame-host';
import type { BurrowSurfaceProvider } from '../burrow/burrow-surface-provider';
import { RemoteApiSession } from '../burrow/remote-api';
import { FrameClient, type FrameSession, type OpenFrame } from './frame-client';

const servers: Array<{ close(): void }> = [];
const sessions: RemoteApiSession[] = [];
const pagesOf = new WeakMap<FrameClient, Map<string, string>>();

afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const server of servers.splice(0)) server.close();
});

function listen(handler: http.RequestListener): Promise<{ port: number; server: http.Server }> {
  const server = http.createServer(handler);
  servers.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    resolve({ port: (server.address() as { port: number }).port, server });
  }));
}

/** A session whose one surface embeds `url`, with every message a macrotask away. */
function connect(pages: Map<string, string>) {
  let inFlight = 0;
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>();
  const events = new Map<string, (event: RemoteEventMsg) => void>();
  const watchers = new Set<() => void>();
  const provider = {
    resolveBrowser: async (surfaceId: string) => {
      const url = pages.get(surfaceId);
      return url ?? null;
    },
    collectDirectory: async () => [...pages].map(([surfaceId, url]) => ({ surfaceId, browser: { render: 'iframe', url } })),
    watchDirectory: (onChange: () => void) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
  } as unknown as BurrowSurfaceProvider;
  const api = new RemoteApiSession({
    burrowId: 'burrow-1',
    provider,
    holder: { id: `holder-${sessions.length}`, label: 'iPhone', serviceId: 'service-1' },
    frames: { host: createBurrowFrameHost({ create: createIframeProxyUrl, release: releaseIframeProxyLease, isLocal: (url) => isUpstreamOnThisMachine(url) }), isDirect: () => true },
    send: (payload) => {
      const wire = JSON.stringify(payload);
      inFlight += wire.length;
      setImmediate(() => {
        inFlight -= wire.length;
        const message = JSON.parse(wire) as RemoteResponse & RemoteEventMsg;
        if (message.requestId !== undefined) {
          const waiting = pending.get(message.requestId);
          pending.delete(message.requestId);
          if (message.ok) waiting?.resolve(message.result);
          else waiting?.reject(new Error(message.error));
        } else {
          events.get(message.subId)?.(message);
        }
      });
    },
  });
  sessions.push(api);
  const request = <T,>(method: string, params?: unknown, requestId: string = globalThis.crypto.randomUUID()) =>
    new Promise<T>((resolve, reject) => {
      pending.set(requestId, { resolve: resolve as (value: unknown) => void, reject });
      setImmediate(() => api.handle(JSON.parse(JSON.stringify({ requestId, method, params }))));
    });
  const session: FrameSession = {
    request,
    async subscribe<T>(method: string, params: unknown, onEvent: (event: RemoteEventMsg) => void, subId: string = globalThis.crypto.randomUUID()) {
      events.set(subId, onEvent);
      try {
        return { subId, result: await request<T>(method, params, subId) };
      } catch (error) {
        events.delete(subId);
        throw error;
      }
    },
    unsubscribe: (subId) => void events.delete(subId),
  };
  const client = new FrameClient(session);
  pagesOf.set(client, pages);
  return { client, notify: () => watchers.forEach((watcher) => watcher()), inFlight: () => inFlight };
}

async function open(client: FrameClient, onClosed?: () => void): Promise<OpenFrame> {
  return client.open({
    surfaceId: 'surface:1',
    pageOrigin: new URL(pagesOf.get(client)!.get('surface:1')!).origin,
    frameOrigin: 'https://frame.example',
    embedderOrigins: ['https://pocket.example'],
    ...(onClosed ? { onClosed } : {}),
  });
}

async function readAll(stream: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function pattern(length: number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i += 1) bytes[i] = (i * 31) & 0xff;
  return bytes;
}

describe('FrameClient', () => {
  it('carries a body many windows long, byte for byte', async () => {
    const payload = pattern(FRAME_FLOW_WINDOW_BYTES * 6 + 17);
    const { port } = await listen((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/octet-stream' });
      res.end(payload);
    });
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    const response = await frame.request({ method: 'GET', path: '/big', headers: [], destination: 'script' });
    expect(response.status).toBe(200);
    expect(Buffer.compare(await readAll(response.body), payload)).toBe(0);
  });

  it('uploads a body larger than one chunk, in order', async () => {
    const payload = pattern(1024 * 1024 + 5);
    const { port } = await listen((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (part: Buffer) => parts.push(part));
      req.on('end', () => res.end(Buffer.compare(Buffer.concat(parts), payload) === 0 ? 'same' : 'different'));
    });
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    const response = await frame.request({ method: 'PUT', path: '/save', headers: [], destination: '', body: payload });
    expect(Buffer.from(await readAll(response.body)).toString()).toBe('same');
  });

  it('never lets a page that stopped reading starve another', async () => {
    const payload = pattern(FRAME_FLOW_WINDOW_BYTES * 48);
    let upstreamFinished = false;
    const { port } = await listen((req, res) => {
      if (req.url === '/stalled') res.on('finish', () => { upstreamFinished = true; });
      res.end(req.url === '/stalled' ? payload : 'small');
    });
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    // Answered, and never read.
    const stalled = await frame.request({ method: 'GET', path: '/stalled', headers: [], destination: 'video' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    // Held: it is not buffering the whole body on the phone.
    expect(upstreamFinished).toBe(false);
    const other = await frame.request({ method: 'GET', path: '/other', headers: [], destination: 'script' });
    expect(Buffer.from(await readAll(other.body)).toString()).toBe('small');
    // And the stalled one still finishes once read.
    expect(Buffer.compare(await readAll(stalled.body), payload)).toBe(0);
  });

  it('keeps the window whole across a cancelled response', async () => {
    const payload = pattern(FRAME_FLOW_WINDOW_BYTES * 3);
    const { port } = await listen((_req, res) => res.end(payload));
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    for (let i = 0; i < 4; i += 1) {
      const response = await frame.request({ method: 'GET', path: '/', headers: [], destination: 'image' });
      await response.body.getReader().cancel();
    }
    const last = await frame.request({ method: 'GET', path: '/', headers: [], destination: 'image' });
    expect(Buffer.compare(await readAll(last.body), payload)).toBe(0);
  });

  it('queues what is past the Burrow\'s bound rather than failing it', async () => {
    const { port } = await listen((req, res) => setTimeout(() => res.end(req.url), 5));
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    const bodies = await Promise.all(Array.from({ length: 200 }, async (_, i) => {
      const response = await frame.request({ method: 'GET', path: `/module-${i}.js`, headers: [], destination: 'script' });
      return Buffer.from(await readAll(response.body)).toString();
    }));
    expect(bodies).toEqual(Array.from({ length: 200 }, (_, i) => `/module-${i}.js`));
  });

  it('rejects a refused request and keeps the frame usable', async () => {
    const { port } = await listen((_req, res) => res.end('ok'));
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    await expect(frame.request({ method: 'CONNECT', path: '/', headers: [] })).rejects.toThrow('invalid http.request: method');
    const response = await frame.request({ method: 'GET', path: '/', headers: [] });
    expect(Buffer.from(await readAll(response.body)).toString()).toBe('ok');
  });

  it('carries a WebSocket, a message many chunks long included', async () => {
    const { port, server } = await listen(() => {});
    const wss = new WebSocketServer({ server });
    servers.push(wss);
    wss.on('connection', (socket) => socket.on('message', (data, binary) => socket.send(data, { binary })));
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    const received: Array<[Uint8Array, boolean]> = [];
    let closed!: (code: number) => void;
    const whenClosed = new Promise<number>((resolve) => { closed = resolve; });
    let gotBoth!: () => void;
    const both = new Promise<void>((resolve) => { gotBoth = resolve; });
    const socket = await frame.openSocket('/hmr', [], {
      onMessage: (data, binary) => {
        received.push([data, binary]);
        if (received.length === 2) gotBoth();
      },
      onClose: (code) => closed(code),
    });
    const big = pattern(1024 * 1024);
    await socket.send(big, true);
    await socket.send(new TextEncoder().encode('hello'), false);
    await both;
    expect(Buffer.compare(received[0]![0], big)).toBe(0);
    expect(received[0]![1]).toBe(true);
    expect(new TextDecoder().decode(received[1]![0])).toBe('hello');
    expect(received[1]![1]).toBe(false);
    socket.close(1000, 'done');
    expect(await whenClosed).toBe(1000);
  });

  it('fails what is in flight when the surface\'s page goes, and tells the opener', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200);
      res.write('partial');
    });
    const pages = new Map([['surface:1', `http://localhost:${port}/`]]);
    const { client, notify } = connect(pages);
    let closed = false;
    const frame = await open(client, () => { closed = true; });
    const response = await frame.request({ method: 'GET', path: '/', headers: [] });
    const reading = readAll(response.body);
    pages.delete('surface:1');
    notify();
    await expect(reading).rejects.toThrow('the embedded page closed');
    expect(closed).toBe(true);
    await expect(frame.request({ method: 'GET', path: '/', headers: [] })).rejects.toThrow('the frame is closed');
  });

  it('dispose fails what is in flight and sends nothing more', async () => {
    const { port } = await listen((_req, res) => {
      res.writeHead(200);
      res.write('partial');
    });
    const { client } = connect(new Map([['surface:1', `http://localhost:${port}/`]]));
    const frame = await open(client);
    const response = await frame.request({ method: 'GET', path: '/', headers: [] });
    const reading = readAll(response.body);
    client.dispose();
    await expect(reading).rejects.toThrow('the session ended');
    await expect(open(client)).rejects.toThrow('the session ended');
  });
});

/** A session that answers nothing until told, to see what is on the wire at once. */
function heldSession() {
  const calls: Array<{ method: string; params: Record<string, unknown>; answer(result?: unknown): void }> = [];
  const hold = <T,>(method: string, params: unknown) => new Promise<T>((resolve) => {
    calls.push({ method, params: params as Record<string, unknown>, answer: (result) => resolve(result as T) });
  });
  const session: FrameSession = {
    request: hold,
    async subscribe<T>(method: string, params: unknown, _onEvent: unknown, subId = 'sub') {
      if (method === FRAME_METHODS.frameOpen) return { subId, result: { path: '/' } as T };
      return { subId, result: await hold<T>(method, params) };
    },
    unsubscribe: () => {},
  };
  return { session, calls, frames: new FrameClient(session) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve));
const chunkBytes = (encoded: unknown) => fromBase64Url(encoded as string).length;
const OPEN = { surfaceId: 'surface:1', pageOrigin: 'http://localhost', frameOrigin: 'https://f.example', embedderOrigins: [] };

describe('what a Client sends', () => {
  it('holds every upload on the session within the window, and finishes them all', async () => {
    const { calls, frames } = heldSession();
    const frame = await frames.open(OPEN);
    const size = FRAME_CHUNK_BYTES * 5 + 1;
    for (let i = 0; i < 10; i += 1) void frame.request({ method: 'PUT', path: `/${i}`, headers: [], body: new Uint8Array(size) });
    await settle();
    const requests = calls.filter((call) => call.method === FRAME_METHODS.httpRequest);
    expect(requests).toHaveLength(10);
    expect(requests.every(({ params }) => params.end === false && !('body' in params))).toBe(true);
    let delivered = 0;
    for (;;) {
      const writes = calls.filter((call) => call.method === FRAME_METHODS.httpWrite);
      const unanswered = writes.reduce((sum, { params }) => sum + chunkBytes(params.bytes), 0);
      expect(unanswered).toBeLessThanOrEqual(FRAME_FLOW_WINDOW_BYTES);
      const next = writes[0];
      if (!next) break;
      calls.splice(calls.indexOf(next), 1);
      delivered += chunkBytes(next.params.bytes);
      next.answer({});
      await settle();
    }
    expect(delivered).toBe(size * 10);
  });

  it('sends nothing for a request abandoned while it waited its turn', async () => {
    const { calls, frames } = heldSession();
    const frame = await frames.open(OPEN);
    const first = frame.request({ method: 'GET', path: '/0', headers: [] });
    for (let i = 1; i < MAX_HTTP_EXCHANGES_PER_SESSION; i += 1) void frame.request({ method: 'GET', path: `/${i}`, headers: [] });
    await settle();
    expect(calls).toHaveLength(MAX_HTTP_EXCHANGES_PER_SESSION);
    const abandoned = new AbortController();
    const waiting = frame.request({ method: 'POST', path: '/save', headers: [], signal: abandoned.signal });
    const refused = expect(waiting).rejects.toThrow('abandoned');
    abandoned.abort();
    calls.shift()!.answer({ status: 200, statusText: 'OK', headers: [] });
    void (await first).body.cancel();
    await settle();
    calls.find((call) => call.method === FRAME_METHODS.httpCancel)!.answer({});
    await refused;
    expect(calls.some((call) => call.params.path === '/save')).toBe(false);
  });

  it('cancels an upload the page abandons before its head', async () => {
    const { calls, frames } = heldSession();
    const frame = await frames.open(OPEN);
    const abandoned = new AbortController();
    void frame.request({ method: 'PUT', path: '/save', headers: [], body: new Uint8Array(FRAME_CHUNK_BYTES * 3), signal: abandoned.signal }).catch(() => {});
    await settle();
    expect(calls.some((call) => call.method === FRAME_METHODS.httpCancel)).toBe(false);
    abandoned.abort();
    await settle();
    expect(calls.some((call) => call.method === FRAME_METHODS.httpCancel)).toBe(true);
  });

  it('acknowledges what a message costs the window, as the Burrow counts it', async () => {
    const small = new Uint8Array(1);
    const asked: Array<{ method: string; params: Record<string, unknown> }> = [];
    let onEvent: (event: RemoteEventMsg) => void = () => {};
    const session: FrameSession = {
      request: async <T,>(method: string, params: unknown) => { asked.push({ method, params: params as Record<string, unknown> }); return {} as T; },
      async subscribe<T>(method: string, _params: unknown, listener: (event: RemoteEventMsg) => void, subId = 'sub') {
        if (method === FRAME_METHODS.frameOpen) return { subId, result: { path: '/' } as T };
        onEvent = listener;
        return { subId, result: { status: 200, statusText: 'OK', headers: [] } as T };
      },
      unsubscribe: () => {},
    };
    const frame = await new FrameClient(session).open(OPEN);
    await frame.request({ method: 'GET', path: '/', headers: [] });
    const body = { subId: 'x', event: FRAME_EVENTS.httpBody, data: { bytes: toBase64Url(small) } } as RemoteEventMsg;
    for (let i = 0; i < 300; i += 1) onEvent(body);
    await new Promise((resolve) => { setTimeout(resolve, 60); });
    const acked = asked.filter(({ method }) => method === FRAME_METHODS.flowAck).reduce((sum, { params }) => sum + (params.bytes as number), 0);
    expect(acked).toBe(300 * (1 + FRAME_FLOW_MESSAGE_COST));
  });

  it('sends a socket\'s close behind what was sent before it', async () => {
    const { calls, frames } = heldSession();
    const frame = await frames.open(OPEN);
    const opening = frame.openSocket('/hmr', [], { onMessage: () => {}, onClose: () => {} });
    await settle();
    calls.shift()!.answer({ protocol: '', extensions: '' });
    const socket = await opening;
    void socket.send(new TextEncoder().encode('commit'), false);
    socket.close(1000, 'done');
    await settle();
    expect(calls.map((call) => call.method)).toEqual([FRAME_METHODS.wsSend]);
    calls.shift()!.answer({});
    await settle();
    expect(calls.map((call) => call.method)).toEqual([FRAME_METHODS.wsClose]);
  });
});

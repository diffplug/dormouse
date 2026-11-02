// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { FrameRequestInit, FrameResponse, FrameSocketHandlers, OpenFrame } from '../client/frame-client';
import { serveFrame } from './frame-bridge';
import { WORKER_SILENCE_LIMIT_MS } from './protocol';
import type { RelayMessage, ResponseMessage, SocketEvent } from './protocol';

const channels: MessagePort[] = [];
afterEach(() => {
  for (const port of channels.splice(0)) port.close();
});

function fakeFrame(overrides: Partial<OpenFrame>): OpenFrame {
  return { id: 'f', path: '/', url: 'http://x/', close() {}, ...overrides } as OpenFrame;
}

/** Past the fake clock, for a message crossing a real port. */
const realTick = () => new Promise<void>((resolve) => { setImmediate(resolve); });

function bridge(frame: OpenFrame) {
  const { port1, port2 } = new MessageChannel();
  channels.push(port1, port2);
  serveFrame(frame, port1);
  return {
    send(message: RelayMessage | unknown): { port: MessagePort; next: () => Promise<unknown> } {
      const reply = new MessageChannel();
      channels.push(reply.port1, reply.port2);
      const inbox: unknown[] = [];
      const waiting: Array<(value: unknown) => void> = [];
      reply.port1.onmessage = (event) => {
        const next = waiting.shift();
        if (next) next(event.data);
        else inbox.push(event.data);
      };
      port2.postMessage(message, [reply.port2]);
      return {
        port: reply.port1,
        next: () => new Promise((resolve) => (inbox.length ? resolve(inbox.shift()) : waiting.push(resolve))),
      };
    },
  };
}

const REQUEST = { kind: 'request', method: 'GET', path: '/a', headers: [], destination: 'script' } as const;

describe('serveFrame', () => {
  it('answers a request head first, then one chunk per pull', async () => {
    let seen: FrameRequestInit | null = null;
    const frame = fakeFrame({
      request: async (init) => {
        seen = init;
        return {
          status: 200, statusText: 'OK', headers: [['x', 'y']],
          body: new Blob(['hello']).stream(),
        } satisfies FrameResponse;
      },
    });
    const { port, next } = bridge(frame).send(REQUEST);
    expect(await next()).toEqual({ kind: 'head', status: 200, statusText: 'OK', headers: [['x', 'y']] });
    expect(seen).toMatchObject({ method: 'GET', path: '/a', destination: 'script' });
    port.postMessage({ kind: 'pull' });
    const chunk = await next() as Extract<ResponseMessage, { kind: 'chunk' }>;
    expect(new TextDecoder().decode(chunk.bytes)).toBe('hello');
    port.postMessage({ kind: 'pull' });
    expect(await next()).toEqual({ kind: 'end' });
  });

  it('reports a refused request as an error, and cancels a body on request', async () => {
    const refused = bridge(fakeFrame({ request: async () => { throw new Error('nope'); } })).send(REQUEST);
    expect(await refused.next()).toEqual({ kind: 'error', message: 'nope' });

    let cancelled!: () => void;
    const whenCancelled = new Promise<void>((resolve) => { cancelled = resolve; });
    const held = bridge(fakeFrame({
      request: async () => ({
        status: 200, statusText: 'OK', headers: [],
        body: new ReadableStream<Uint8Array>({ cancel: () => cancelled() }),
      }),
    })).send(REQUEST);
    await held.next();
    held.port.postMessage({ kind: 'cancel' });
    await whenCancelled;
  });

  it('carries a socket both ways', async () => {
    let handlers!: FrameSocketHandlers;
    const sent: Array<[string, boolean]> = [];
    let closedWith: unknown[] = [];
    const frame = fakeFrame({
      openSocket: async (_path, _protocols, given) => {
        handlers = given;
        return {
          protocol: 'p', extensions: '',
          send: async (data, binary) => void sent.push([new TextDecoder().decode(data), binary]),
          close: (...args) => { closedWith = args; },
        };
      },
    });
    const { port, next } = bridge(frame).send({ kind: 'socket', path: '/hmr', protocols: ['p'] });
    expect(await next()).toEqual({ kind: 'open', protocol: 'p', extensions: '' });
    handlers.onMessage(new TextEncoder().encode('down'), false);
    const down = await next() as Extract<SocketEvent, { kind: 'message' }>;
    expect(new TextDecoder().decode(down.data)).toBe('down');
    port.postMessage({ kind: 'send', data: new TextEncoder().encode('up').buffer, binary: true });
    port.postMessage({ kind: 'close', code: 1000, reason: 'done' });
    await expect.poll(() => closedWith).toEqual([1000, 'done']);
    expect(sent).toEqual([['up', true]]);
    handlers.onClose(1000, 'done');
    expect(await next()).toEqual({ kind: 'closed', code: 1000, reason: 'done' });
  });

  it('reads a Blob in its place, ahead of the close behind it', async () => {
    const order: string[] = [];
    const frame = fakeFrame({
      openSocket: async () => ({
        protocol: '', extensions: '',
        send: async (data: Uint8Array) => { order.push(`send ${new TextDecoder().decode(data)}`); },
        close: () => { order.push('close'); },
      }),
    });
    const read = Blob.prototype.arrayBuffer;
    vi.spyOn(Blob.prototype, 'arrayBuffer').mockImplementation(async function slowly(this: Blob) {
      await new Promise((resolve) => { setTimeout(resolve, 20); });
      return read.call(this);
    });
    const { port, next } = bridge(frame).send({ kind: 'socket', path: '/hmr', protocols: [] });
    await next();
    port.postMessage({ kind: 'send', data: new Blob(['later']), binary: true });
    port.postMessage({ kind: 'close' });
    await expect.poll(() => order).toEqual(['send later', 'close']);
    vi.restoreAllMocks();
  });

  it('abandons a request the worker gave up on before its head', async () => {
    let signal: AbortSignal | undefined;
    let answer: (response: FrameResponse) => void = () => {};
    const frame = fakeFrame({
      request: (init: FrameRequestInit) => {
        signal = init.signal;
        return new Promise<FrameResponse>((resolve) => { answer = resolve; });
      },
    });
    const { port } = bridge(frame).send({ kind: 'request', method: 'POST', path: '/save', headers: [], destination: '' });
    await expect.poll(() => signal).toBeDefined();
    expect(signal!.aborted).toBe(false);
    port.postMessage({ kind: 'cancel' });
    await expect.poll(() => signal!.aborted).toBe(true);
    const cancelled = vi.fn();
    answer({ status: 200, statusText: 'OK', headers: [], body: new ReadableStream({ cancel: cancelled }) });
    await expect.poll(() => cancelled.mock.calls.length).toBe(1);
  });

  it('ends a response whose worker stopped saying it runs', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const cancelled = vi.fn();
      const frame = fakeFrame({
        request: async () => ({ status: 200, statusText: 'OK', headers: [], body: new ReadableStream({ cancel: cancelled }) }),
      });
      const { port, next } = bridge(frame).send({ kind: 'request', method: 'GET', path: '/events', headers: [], destination: '' });
      await next();
      await realTick();
      vi.advanceTimersByTime(WORKER_SILENCE_LIMIT_MS - 1_000);
      port.postMessage({ kind: 'alive' });
      await realTick();
      await realTick();
      vi.advanceTimersByTime(WORKER_SILENCE_LIMIT_MS - 1_000);
      await realTick();
      expect(cancelled).not.toHaveBeenCalled();
      vi.advanceTimersByTime(2_000);
      await realTick();
      expect(cancelled).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('ignores what is not a relay message, since a framed page can write here', async () => {
    let asked = 0;
    const b = bridge(fakeFrame({ request: async () => { asked += 1; throw new Error('x'); } }));
    b.send(null);
    b.send({ kind: 'launch', url: 'http://evil.example' });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(asked).toBe(0);
  });
});

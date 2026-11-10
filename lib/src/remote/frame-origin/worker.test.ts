// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { installFrameWorker, refusal, relayHeaders, responseFrom, type FrameWorkerScope } from './worker';
import { WORKER_ALIVE_MS, type RelayRequest, type ResponseControl, type ResponseMessage } from './protocol';

const ORIGIN = 'https://frame.example';

describe('refusal', () => {
  const nav = { mode: 'navigate' as RequestMode, method: 'GET', destination: 'iframe' as RequestDestination, referrer: '' };

  it('passes what a frame does: its navigations, and any fetch of its own', () => {
    expect(refusal(nav, ORIGIN)).toBeNull();
    expect(refusal({ ...nav, method: 'POST', referrer: `${ORIGIN}/form` }, ORIGIN)).toBeNull();
    expect(refusal({ ...nav, mode: 'cors', method: 'POST', destination: '' }, ORIGIN)).toBeNull();
  });

  it('passes a form with no referrer, which is a page\'s own policy', () => {
    expect(refusal({ ...nav, method: 'POST', referrer: '' }, ORIGIN)).toBeNull();
  });

  it('refuses a top-level page, and a form another site aimed here', () => {
    expect(refusal({ ...nav, destination: 'document' }, ORIGIN)).toMatch(/inside Dormouse/);
    expect(refusal({ ...nav, method: 'POST', referrer: 'https://evil.example/' }, ORIGIN)).toMatch(/another site/);
  });
});

describe('relayHeaders', () => {
  const of = (method: string, referrer: string, headers: Record<string, string> = {}, mode: RequestMode = 'cors') =>
    relayHeaders({ method, mode, referrer, headers: new Headers(headers) }, ORIGIN);

  it('vouches for no form that names no referrer, though it does for a fetch', () => {
    expect(of('POST', '', {}, 'navigate')).toEqual([['origin', 'null']]);
    expect(of('POST', '')).toEqual([['origin', ORIGIN]]);
    expect(of('POST', `${ORIGIN}/a`, {}, 'navigate')).toContainEqual(['origin', ORIGIN]);
  });

  it('names the frame origin on a write only, and carries the referrer', () => {
    expect(of('POST', `${ORIGIN}/a`, { 'content-type': 'text/plain' })).toEqual([
      ['content-type', 'text/plain'], ['origin', ORIGIN], ['referer', `${ORIGIN}/a`],
    ]);
    expect(of('GET', '')).toEqual([]);
    expect(of('GET', 'about:client')).toEqual([]);
  });
});

/** A channel whose far end is driven by hand, recording what the worker asks. */
function answering() {
  const { port1, port2 } = new MessageChannel();
  const asked: ResponseControl[] = [];
  port2.onmessage = (event) => asked.push(event.data as ResponseControl);
  return { response: responseFrom(port1, () => {}), send: (message: ResponseMessage) => port2.postMessage(message), asked, port2 };
}

describe('responseFrom', () => {
  const realTick = () => new Promise<void>((resolve) => { setImmediate(resolve); });
  const fakeClock = () => vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });

  it('tells the Client window when it gives up on a head, and is finished', async () => {
    fakeClock();
    try {
      const { port1, port2 } = new MessageChannel();
      const asked: unknown[] = [];
      port2.onmessage = (event) => asked.push(event.data);
      const finished = vi.fn();
      const response = responseFrom(port1, finished);
      vi.advanceTimersByTime(65_000);
      expect((await response).status).toBe(504);
      expect(finished).toHaveBeenCalledOnce();
      await vi.waitFor(() => { expect(asked).toEqual([{ kind: 'cancel' }]); }, { interval: 1 });
      port2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('tells the Client window when the page aborts, so a waiting request stops', async () => {
    const { port1, port2 } = new MessageChannel();
    const asked: unknown[] = [];
    port2.onmessage = (event) => asked.push(event.data);
    const aborted = new AbortController();
    const finished = vi.fn();
    const response = responseFrom(port1, finished, aborted.signal);
    aborted.abort();
    await vi.waitFor(() => { expect(asked).toEqual([{ kind: 'cancel' }]); }, { interval: 1 });
    expect(finished).toHaveBeenCalled();
    // And the fetch event is answered, not left pending with no timer to end it.
    expect((await Promise.race([response, new Promise((resolve) => setTimeout(resolve, 100, null))]) as Response | null)?.status).toBe(503);
    port2.close();
  });

  it('says it still runs while a response is open, and stops with it', async () => {
    fakeClock();
    try {
      const { port1, port2 } = new MessageChannel();
      const asked: unknown[] = [];
      port2.onmessage = (event) => asked.push(event.data);
      const finished = vi.fn();
      const pending = responseFrom(port1, finished);
      port2.postMessage({ kind: 'head', status: 200, statusText: 'OK', headers: [] });
      const { body } = await pending;
      vi.advanceTimersByTime(WORKER_ALIVE_MS);
      await realTick();
      expect(asked.filter((control) => (control as { kind: string }).kind === 'alive')).toHaveLength(1);
      expect(finished).not.toHaveBeenCalled();
      await body!.cancel();
      expect(finished).toHaveBeenCalledOnce();
      expect(vi.getTimerCount()).toBe(0);
      port2.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it('pulls one chunk per read, and ends', async () => {
    const t = answering();
    t.send({ kind: 'head', status: 201, statusText: 'Made', headers: [['x-a', '1'], ['x-a', '2'], ['bad name', 'dropped']] });
    const response = await t.response;
    expect(response.status).toBe(201);
    expect(response.headers.get('x-a')).toBe('1, 2');
    const reader = response.body!.getReader();
    const first = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(t.asked).toEqual([{ kind: 'pull' }]);
    t.send({ kind: 'chunk', bytes: new TextEncoder().encode('hi') });
    expect(new TextDecoder().decode((await first).value)).toBe('hi');
    const last = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    t.send({ kind: 'end' });
    expect((await last).done).toBe(true);
    t.port2.close();
  });

  it('gives a null-body status no body, and refuses a status Response cannot hold', async () => {
    const empty = answering();
    empty.send({ kind: 'head', status: 204, statusText: '', headers: [] });
    expect((await empty.response).body).toBeNull();
    const nonsense = answering();
    nonsense.send({ kind: 'head', status: 99, statusText: '', headers: [] });
    expect((await nonsense.response).status).toBe(502);
    const phrase = answering();
    phrase.send({ kind: 'head', status: 200, statusText: 'O\u0001K', headers: [] });
    expect((await Promise.race([phrase.response, new Promise((resolve) => setTimeout(resolve, 100, null))]) as Response | null)?.status).toBe(200);
    empty.port2.close();
    nonsense.port2.close();
    phrase.port2.close();
  });

  it('answers a failure before the head as a page, and after it as a broken body', async () => {
    const before = answering();
    before.send({ kind: 'error', message: 'too many' });
    const page = await before.response;
    expect(page.status).toBe(502);
    expect(await page.text()).toBe('too many');
    const after = answering();
    after.send({ kind: 'head', status: 200, statusText: 'OK', headers: [] });
    const reader = (await after.response).body!.getReader();
    const read = reader.read();
    await new Promise((resolve) => setTimeout(resolve, 5));
    after.send({ kind: 'error', message: 'gone' });
    await expect(read).rejects.toThrow('gone');
    before.port2.close();
    after.port2.close();
  });
});

describe('installFrameWorker', () => {
  function install(windows: Array<{ url: string; postMessage: (message: unknown, transfer: Transferable[]) => void }>) {
    const listeners = new Map<string, (event: unknown) => void>();
    const scope = {
      location: { origin: ORIGIN },
      clients: { matchAll: async () => windows, claim: async () => {} },
      skipWaiting: async () => {},
      addEventListener: (type: string, listener: (event: unknown) => void) => listeners.set(type, listener),
    } as unknown as FrameWorkerScope;
    installFrameWorker(scope);
    const fetch = (url: string, init?: RequestInit): Promise<Response> | null => {
      let answer: Promise<Response> | null = null;
      listeners.get('fetch')!({ request: new Request(url, init), respondWith: (response: Promise<Response>) => { answer = response; } });
      return answer;
    };
    const message = async (data: unknown, ports: MessagePort[]) => {
      let settled: Promise<unknown> = Promise.resolve();
      listeners.get('message')!({ data, ports, waitUntil: (promise: Promise<unknown>) => { settled = promise; } });
      await settled;
    };
    return { fetch, message };
  }

  it('leaves other origins and its own assets to the network', () => {
    const { fetch } = install([]);
    expect(fetch('https://cdn.example/x.js')).toBeNull();
    expect(fetch(`${ORIGIN}/__dormouse-frame-sw.js`)).toBeNull();
    expect(fetch(`${ORIGIN}/__dormouse-frame/bootstrap.js`)).toBeNull();
  });

  it('answers 503 with no Client window to relay through', async () => {
    const { fetch } = install([{ url: `${ORIGIN}/app`, postMessage: () => {} }]);
    expect((await fetch(`${ORIGIN}/app.js`)!).status).toBe(503);
  });

  it('relays only a socket with its port, whatever else a page posts it', async () => {
    const relayed: unknown[] = [];
    const { message } = install([{
      url: `${ORIGIN}/__dormouse-frame/bootstrap.html`,
      postMessage: (data) => relayed.push(data),
    }]);
    const { port1, port2 } = new MessageChannel();
    await message({ kind: 'request', method: 'GET', path: '/' }, [port1]);
    await message({ kind: 'socket', path: '/hmr', protocols: [] }, []);
    await message(null, [port1]);
    expect(relayed).toEqual([]);
    await message({ kind: 'socket', path: '/hmr', protocols: [] }, [port1]);
    expect(relayed).toEqual([{ kind: 'socket', path: '/hmr', protocols: [] }]);
    port2.close();
  });

  it('sends nothing for a request the page aborted before it could go', async () => {
    const relayed: unknown[] = [];
    const { fetch } = install([{
      url: `${ORIGIN}/__dormouse-frame/bootstrap.html`,
      postMessage: (message) => relayed.push(message),
    }]);
    const aborted = new AbortController();
    const answer = fetch(`${ORIGIN}/save`, { method: 'POST', body: 'text', signal: aborted.signal })!;
    aborted.abort();
    await answer;
    expect(relayed).toEqual([]);
  });

  it('relays a same-origin request to the bootstrap page, path and body whole', async () => {
    const relayed: Array<[RelayRequest, Transferable[]]> = [];
    const { fetch } = install([{
      url: `${ORIGIN}/__dormouse-frame/bootstrap.html`,
      postMessage: (message, transfer) => {
        relayed.push([message as RelayRequest, transfer]);
        (transfer[0] as MessagePort).postMessage({ kind: 'head', status: 204, statusText: '', headers: [] } satisfies ResponseMessage);
      },
    }]);
    const response = await fetch(`${ORIGIN}/save?x=1#ignored`, { method: 'PUT', body: 'text' })!;
    expect(response.status).toBe(204);
    const [message] = relayed[0]!;
    expect(message).toMatchObject({ kind: 'request', method: 'PUT', path: '/save?x=1' });
    expect(new TextDecoder().decode(message.body)).toBe('text');
    expect(message.headers).toContainEqual(['origin', ORIGIN]);
  });
});

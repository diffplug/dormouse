// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { installFrameWorker, refusal, relayHeaders, responseFrom, type FrameWorkerScope } from './worker';
import type { RelayRequest, ResponseControl, ResponseMessage } from './protocol';

const ORIGIN = 'https://frame.example';

describe('refusal', () => {
  const nav = { mode: 'navigate' as RequestMode, method: 'GET', destination: 'iframe' as RequestDestination, referrer: '' };

  it('passes what a frame does: its navigations, and any fetch of its own', () => {
    expect(refusal(nav, ORIGIN)).toBeNull();
    expect(refusal({ ...nav, method: 'POST', referrer: `${ORIGIN}/form` }, ORIGIN)).toBeNull();
    expect(refusal({ ...nav, mode: 'cors', method: 'POST', destination: '' }, ORIGIN)).toBeNull();
  });

  it('refuses a top-level page, and a form another site aimed here', () => {
    expect(refusal({ ...nav, destination: 'document' }, ORIGIN)).toMatch(/inside Dormouse/);
    expect(refusal({ ...nav, method: 'POST', referrer: 'https://evil.example/' }, ORIGIN)).toMatch(/another site/);
    expect(refusal({ ...nav, method: 'POST' }, ORIGIN)).toMatch(/another site/);
  });
});

describe('relayHeaders', () => {
  const of = (method: string, referrer: string, headers: Record<string, string> = {}) =>
    relayHeaders({ method, referrer, headers: new Headers(headers) }, ORIGIN);

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
  return { response: responseFrom(port1), send: (message: ResponseMessage) => port2.postMessage(message), asked, port2 };
}

describe('responseFrom', () => {
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
    empty.port2.close();
    nonsense.port2.close();
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
    return { fetch };
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

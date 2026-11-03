// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: unknown) => void;

async function load(cookies = '') {
  vi.resetModules();
  const written: string[] = [];
  vi.stubGlobal('location', { hostname: 'aaaa1111.frames.example' });
  vi.stubGlobal('document', {
    get cookie() { return cookies; },
    set cookie(value: string) { written.push(value); },
  });
  const parentWindow = {};
  const listeners: { window?: Listener; worker?: Listener } = {};
  vi.stubGlobal('window', {
    parent: parentWindow,
    addEventListener: (_type: string, listener: Listener) => { listeners.window = listener; },
  });
  vi.stubGlobal('navigator', {
    serviceWorker: {
      register: async () => ({}),
      ready: Promise.resolve({}),
      addEventListener: (_type: string, listener: Listener) => { listeners.worker = listener; },
      startMessages: () => {},
    },
  });
  await import('./bootstrap');
  return { parentWindow, connect: listeners.window!, fromWorker: listeners.worker!, written };
}

const port = () => ({ postMessage: vi.fn(), close: vi.fn() });
const CONNECT = { kind: 'dormouse-frame-connect' };

afterEach(() => vi.unstubAllGlobals());

describe('the bootstrap page', () => {
  it('expires what it can see on the parent domain alone, nameless and partitioned cookies included, before the frame page loads', async () => {
    const { written } = await load('left=by-a-sibling; a=b=c; nameless');
    expect(written).toEqual(['left', 'a', ''].flatMap((name) => ['', '; Partitioned'].map(
      (jar) => `${name}=; Domain=frames.example; Path=/; Max-Age=0; Secure; SameSite=None${jar}`,
    )));
  });

  it('takes its port from the parent alone, and only the first', async () => {
    const { parentWindow, connect, fromWorker } = await load();
    const foreign = port();
    connect({ source: {}, data: CONNECT, ports: [foreign] });
    const wrongKind = port();
    connect({ source: parentWindow, data: { kind: 'other' }, ports: [wrongKind] });

    // Nothing is connected yet, so a relay has nowhere to go.
    const orphan = port();
    fromWorker({ data: { kind: 'socket' }, ports: [orphan] });
    expect(orphan.close).toHaveBeenCalled();

    const real = port();
    connect({ source: parentWindow, data: CONNECT, ports: [real] });
    await vi.waitFor(() => expect(real.postMessage).toHaveBeenCalledWith({ kind: 'ready' }));
    const second = port();
    connect({ source: parentWindow, data: CONNECT, ports: [second] });

    const reply = port();
    const message = { kind: 'socket', path: '/hmr', protocols: [] };
    fromWorker({ data: message, ports: [reply] });
    expect(real.postMessage).toHaveBeenLastCalledWith(message, [reply]);
    for (const refused of [foreign, wrongKind, second]) expect(refused.postMessage).not.toHaveBeenCalled();
  });
});

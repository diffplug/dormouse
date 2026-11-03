// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';

type Listener = (event: unknown) => void;

/** One cookie as a browser files it: a write matching all three of its key fields replaces it. */
interface Stored {
  name: string;
  value: string;
  domain: string;
  partitioned: boolean;
}

/**
 * `document.cookie` as RFC 6265bis parses a write: no `=` is a nameless cookie
 * holding the whole pair, and an empty name with an empty value is dropped.
 */
function cookieJar(seed: Stored[]) {
  const jar = [...seed];
  return {
    jar,
    get cookie() {
      return jar.map(({ name, value }) => (name ? `${name}=${value}` : value)).join('; ');
    },
    set cookie(line: string) {
      const [pair, ...attributes] = line.split('; ');
      const at = pair.indexOf('=');
      const [name, value] = at < 0 ? ['', pair] : [pair.slice(0, at), pair.slice(at + 1)];
      if (!name && !value) return;
      const domain = attributes.find((one) => one.startsWith('Domain='))?.slice('Domain='.length) ?? '';
      const partitioned = attributes.includes('Partitioned');
      const held = jar.findIndex((one) => one.name === name && one.domain === domain && one.partitioned === partitioned);
      if (held >= 0) jar.splice(held, 1);
      if (!attributes.includes('Max-Age=0')) jar.push({ name, value, domain, partitioned });
    },
  };
}

async function load(cookies: Stored[] = []) {
  vi.resetModules();
  const page = cookieJar(cookies);
  vi.stubGlobal('location', { hostname: 'aaaa1111.frames.example' });
  vi.stubGlobal('document', page);
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
  return { parentWindow, connect: listeners.window!, fromWorker: listeners.worker!, jar: page.jar };
}

const port = () => ({ postMessage: vi.fn(), close: vi.fn() });
const CONNECT = { kind: 'dormouse-frame-connect' };

afterEach(() => vi.unstubAllGlobals());

describe('the bootstrap page', () => {
  it('expires what it can see on the parent domain alone, nameless and partitioned cookies included, before the frame page loads', async () => {
    const parent = { domain: 'frames.example', partitioned: false };
    const own = { name: 'left', value: 'mine', domain: '', partitioned: false };
    const { jar } = await load([
      { ...parent, name: 'left', value: 'by-a-sibling' },
      { ...parent, name: 'a', value: 'b=c' },
      { ...parent, name: '', value: 'nameless' },
      { ...parent, name: 'kept', value: '1', partitioned: true },
      { ...parent, name: '', value: 'x=y', partitioned: true },
      own,
    ]);
    expect(jar).toEqual([own]);
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

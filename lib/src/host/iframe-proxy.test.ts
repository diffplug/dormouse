import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as http from 'node:http';
import * as net from 'node:net';
import { createIframeProxyUrl } from './iframe-proxy';

// The app's own ancestor chain, as `lib/src/lib/embedder-origins.ts` reports it
// from a VS Code webview: the extension's document plus the workbench above it.
const APP_ORIGINS = ['vscode-webview://abc-123', 'vscode-file://vscode-app'];

// Integration coverage for the Node proxy server (esbuild-only otherwise): we
// stand up a real loopback upstream, front it with createIframeProxyUrl, and
// fetch through the returned proxy URL — exercising the streaming shim
// injection, header rewriting, and error paths end to end.

const NO_LOG = { log: () => {}, embedderOrigins: APP_ORIGINS };
// A host that could not establish its chain, or a caller that sent none.
const NO_EMBEDDER = { log: () => {} };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const upstreams: http.Server[] = [];

// Only `Date` is faked: the servers under test need real I/O timers. Grant
// expiry and the sweep interval are both read off `Date.now()`, so this is
// enough to drive them without a five-minute wait — and it keeps the
// assertions behavioral (is the grant's server still listening?) rather than
// reaching into module state.
//
// The offset only ever grows, across tests as well as within one: the proxy's
// `lastSweep` is module state that outlives a test, and a clock that went
// backwards between tests would leave it in the future and suppress every
// later sweep.
const CLOCK_START = Date.now();
let clockOffset = 0;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'], now: CLOCK_START + clockOffset });
});
afterEach(() => {
  for (const s of upstreams.splice(0)) s.close();
});
afterAll(() => {
  vi.useRealTimers();
});

function advanceClock(ms: number): void {
  clockOffset += ms;
  vi.setSystemTime(CLOCK_START + clockOffset);
}

/** Force the lazy sweep: it runs on the next grant creation. */
async function sweep(): Promise<void> {
  const port = await upstream((_q, s) => { s.writeHead(204); s.end(); });
  await createIframeProxyUrl(`http://127.0.0.1:${port}/`, NO_LOG);
}

function isListening(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect(port, '127.0.0.1', () => { socket.destroy(); resolve(true); });
    socket.on('error', () => resolve(false));
  });
}

function upstream(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  upstreams.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    resolve(typeof a === 'object' && a ? a.port : 0);
  }));
}

interface Fetched { status: number; headers: http.IncomingHttpHeaders; body: string }
function request(url: string, init: { method?: string; headers?: Record<string, string> } = {}): Promise<Fetched> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: init.method ?? 'GET',
      headers: init.headers,
    }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end();
  });
}
const get = (url: string) => request(url);

async function frame(target: string, opts = NO_LOG): Promise<string> {
  const r = await createIframeProxyUrl(target, opts);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.url;
}

/** Send a raw WebSocket upgrade at the proxy and capture what upstream saw. */
function upgrade(url: string, headers: Record<string, string>): Promise<string> {
  const u = new URL(url);
  return new Promise((resolve, reject) => {
    const socket = net.connect(Number(u.port), u.hostname, () => {
      const lines = Object.entries(headers).map(([k, v]) => `${k}: ${v}`);
      socket.write(`GET /hmr HTTP/1.1\r\n${lines.join('\r\n')}\r\n\r\n`);
    });
    let seen = '';
    socket.on('data', (c: Buffer) => { seen += c.toString('utf8'); });
    socket.on('close', () => resolve(seen));
    socket.on('error', reject);
    setTimeout(() => socket.destroy(), 250);
  });
}

/** An upstream that reports its upgrade request back down the same socket. */
function echoUpgradeUpstream(): Promise<number> {
  const server = http.createServer();
  server.on('upgrade', (req, socket) => {
    socket.end(JSON.stringify({
      host: req.headers.host ?? null,
      origin: req.headers.origin ?? null,
    }));
  });
  upstreams.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    resolve(typeof a === 'object' && a ? a.port : 0);
  }));
}

describe('createIframeProxyUrl — admission', () => {
  it('rejects non-http schemes (https deferred)', async () => {
    const r = await createIframeProxyUrl('https://example.com/', NO_LOG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scheme');
  });

  it('refuses link-local / cloud-metadata addresses (SSRF)', async () => {
    const r = await createIframeProxyUrl('http://169.254.169.254/latest/meta-data/', NO_LOG);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toBe('scheme');
  });

  it('preserves the target path + query in the framed URL', async () => {
    const port = await upstream((_q, s) => { s.writeHead(200, { 'content-type': 'text/html' }); s.end('<html><head></head><body>x</body></html>'); });
    const url = await frame(`http://127.0.0.1:${port}/app/page?q=1`);
    const u = new URL(url);
    expect(u.hostname).toBe('127.0.0.1');
    expect(u.pathname).toBe('/app/page');
    expect(u.search).toBe('?q=1');
  });
});

describe('iframe proxy — serving', () => {
  // The proxy no longer branches on loopback vs remote: any http upstream's
  // frame-blocking headers are stripped and the shim injected. A DENY/none upstream
  // that would previously be diverted to a "refuses to be embedded" page is framed.
  it('instruments HTML: strips XFO + CSP, injects the shim, keeps content', async () => {
    const port = await upstream((_q, s) => {
      s.writeHead(200, {
        'content-type': 'text/html',
        'x-frame-options': 'DENY',
        'content-security-policy': "frame-ancestors 'none'",
      });
      s.end(`<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'none'"><title>t</title></head><body>hello</body></html>`);
    });
    const res = await get(await frame(`http://127.0.0.1:${port}/`));

    expect(res.status).toBe(200);
    expect(res.headers['x-frame-options']).toBeUndefined();
    // Replaced, not merely dropped: same-grant documents may nest, while every
    // external ancestor still has to belong to this webview's validated chain.
    expect(res.headers['content-security-policy'])
      .toBe("frame-ancestors 'self' vscode-webview://abc-123 vscode-file://vscode-app");
    expect(res.body).not.toMatch(/http-equiv=["']?content-security-policy/i);
    expect(res.body).toContain('__dormouse');
    expect(res.body).toMatch(/<\/script><\/head>/);
    expect(res.body).toContain('<body>hello</body>');
  });

  it('streams: injects the shim when </head> and a multibyte char split across chunks', async () => {
    const html = Buffer.from('<html><head><title>A—B</title></head><body>hello—world</body></html>', 'utf8');
    const headIdx = html.indexOf('</head>') + 3;                          // inside the tag
    const emIdx = html.indexOf(Buffer.from([0xe2, 0x80, 0x94])) + 1;      // inside the em-dash bytes
    const [a, b] = [emIdx, headIdx].sort((x, y) => x - y);
    const slices = [html.subarray(0, a), html.subarray(a, b), html.subarray(b)];
    const port = await upstream(async (_q, s) => {
      s.writeHead(200, { 'content-type': 'text/html' });
      for (const slice of slices) { s.write(slice); await delay(2); }
      s.end();
    });
    const res = await get(await frame(`http://127.0.0.1:${port}/`));

    expect(res.body).toContain('__dormouse');
    expect(res.body).toMatch(/<\/script><\/head>/);
    expect(res.body).toContain('A—B');          // multibyte split mid-byte, intact
    expect(res.body).toContain('hello—world');  // body (after the streamed head) intact
    // Instrumentation changes length → chunked, not a (now-wrong) content-length.
    expect(res.headers['content-length']).toBeUndefined();
    expect(res.headers['transfer-encoding']).toBe('chunked');
  });

  it('passes non-HTML through untouched (no shim), still stripping framing headers', async () => {
    const port = await upstream((_q, s) => {
      s.writeHead(200, { 'content-type': 'application/javascript', 'x-frame-options': 'SAMEORIGIN' });
      s.end('export const x = 1;');
    });
    const res = await get(await frame(`http://127.0.0.1:${port}/dep.js`));

    expect(res.body).toBe('export const x = 1;');
    expect(res.body).not.toContain('__dormouse');
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.headers['content-security-policy'])
      .toBe("frame-ancestors 'self' vscode-webview://abc-123 vscode-file://vscode-app");
  });

  it('rewrites an upstream-origin Location redirect onto the proxy origin', async () => {
    let upstreamOrigin = '';
    const port = await upstream((_q, s) => { s.writeHead(302, { location: `${upstreamOrigin}/next` }); s.end(); });
    upstreamOrigin = `http://127.0.0.1:${port}`;
    const url = await frame(`http://127.0.0.1:${port}/`);
    const res = await get(url); // http.get does not follow redirects

    expect(res.status).toBe(302);
    expect(res.headers.location).toBe(`${new URL(url).origin}/next`);
  });

  it('serves an actionable error page (frameable) when the upstream is unreachable', async () => {
    const res = await get(await frame('http://127.0.0.1:1/')); // port 1: connection refused

    expect(res.status).toBe(200);
    expect(res.body).toMatch(/dev server running|couldn’t reach/i);
    expect(res.headers['x-frame-options']).toBeUndefined();
  });
});

describe('iframe proxy — the proxy never vouches for a stranger', () => {
  // The port is ephemeral but not secret: the range scans in seconds, and a
  // page in the user's own browser reaches loopback as easily as our webview
  // does. So the Origin rewrite — the proxy telling the upstream "this came
  // from you" — must be reserved for callers we actually served. See
  // ./loopback-guard.ts for the shared rule.
  let upstreamPort = 0;
  let proxyPort = '';
  let url = '';

  beforeEach(async () => {
    // An upstream that reports back exactly what it was told about its caller.
    upstreamPort = await upstream((q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end(JSON.stringify({ origin: q.headers.origin ?? null, host: q.headers.host ?? null }));
    });
    url = await frame(`http://127.0.0.1:${upstreamPort}/`);
    proxyPort = new URL(url).port;
  });

  const post = (headers: Record<string, string>) => request(url, { method: 'POST', headers });

  it('relabels the Origin of a page it served', async () => {
    const res = await post({ host: `127.0.0.1:${proxyPort}`, origin: `http://127.0.0.1:${proxyPort}` });

    // The legitimate iframe: origin-aware dev servers must see same-origin.
    expect(JSON.parse(res.body)).toEqual({ origin: `http://127.0.0.1:${upstreamPort}`, host: `127.0.0.1:${upstreamPort}` });
  });

  it('forwards a foreign Origin untouched instead of laundering it', async () => {
    const res = await post({ host: `127.0.0.1:${proxyPort}`, origin: 'https://evil.example' });

    // Forwarded, not blocked: the upstream sees the truth and applies its own
    // CSRF policy, so the proxy grants nothing that hitting the upstream port
    // directly would not.
    expect(JSON.parse(res.body).origin).toBe('https://evil.example');
  });

  it('leaves an absent Origin absent (top-level navigation, same-origin GET)', async () => {
    const res = await post({ host: `127.0.0.1:${proxyPort}` });

    expect(JSON.parse(res.body).origin).toBeNull();
  });

  it('refuses a request addressed to a rebound hostile name', async () => {
    // evil.example re-resolved to 127.0.0.1 arrives with its own name in Host,
    // and the browser treats the response as same-origin — so no CORS header
    // would get a say. 421 Misdirected Request, before the upstream is dialed.
    const res = await post({ host: 'evil.example:1234', origin: 'https://evil.example' });

    expect(res.status).toBe(421);
    expect(res.body).toBe('');
  });

  it('accepts either loopback spelling in Host', async () => {
    for (const host of [`127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`]) {
      expect((await post({ host })).status).toBe(200);
    }
  });
});

describe('iframe proxy — the two privileges are the embedder’s, not the port’s', () => {
  // The loopback port is not a secret, and no request header separates our
  // webview from an attacker page: an iframe navigation carries no `Origin`,
  // and `Sec-Fetch-Site` reads `cross-site` for both. So the framing-header
  // strip and the shim — framing an upstream that said DENY, and reading its
  // URLs back cross-origin — may not be handed out per *request*. They are
  // handed out per *embedder*, enforced by the browser through frame-ancestors.
  const DENY_HTML = (s: http.ServerResponse) => {
    s.writeHead(200, {
      'content-type': 'text/html',
      'x-frame-options': 'DENY',
      'content-security-policy': "frame-ancestors 'none'; script-src 'self'",
    });
    s.end('<html><head></head><body>secret</body></html>');
  };

  it("allows only the grant itself and the app's ancestor chain to frame it", async () => {
    const port = await upstream((_q, s) => DENY_HTML(s));
    const res = await get(await frame(`http://127.0.0.1:${port}/`));

    expect(res.headers['content-security-policy'])
      .toBe("frame-ancestors 'self' vscode-webview://abc-123 vscode-file://vscode-app");
    expect(res.headers['x-frame-options']).toBeUndefined();
    expect(res.body).toContain('__dormouse');
  });

  it('leaves the upstream’s framing controls alone when no embedder is known', async () => {
    // No chain means nobody to name in frame-ancestors and nobody to address
    // the shim to. The proxy then grants nothing at all: a stranger who scans
    // the port gets exactly what the upstream would have given them directly.
    const port = await upstream((_q, s) => DENY_HTML(s));
    const res = await get(await frame(`http://127.0.0.1:${port}/`, NO_EMBEDDER));

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.headers['content-security-policy']).toBe("frame-ancestors 'none'; script-src 'self'");
    expect(res.body).not.toContain('__dormouse');
    expect(res.body).toContain('secret');
  });

  it('refuses an embedder chain it cannot use in full', async () => {
    // An opaque ancestor cannot be spelled in CSP, and a partial chain would
    // block Dormouse's own frame — so it degrades to granting nothing.
    const port = await upstream((_q, s) => DENY_HTML(s));
    const res = await get(await frame(`http://127.0.0.1:${port}/`, {
      log: () => {},
      embedderOrigins: ['vscode-webview://abc-123', 'null'],
    }));

    expect(res.headers['x-frame-options']).toBe('DENY');
    expect(res.body).not.toContain('__dormouse');
  });

  it('addresses the injected shim at the app rather than at whoever framed it', async () => {
    const port = await upstream((_q, s) => {
      s.writeHead(200, { 'content-type': 'text/html' });
      s.end('<html><head></head><body>x</body></html>');
    });
    const res = await get(await frame(`http://127.0.0.1:${port}/`));

    expect(res.body).toContain('var TARGET="vscode-webview://abc-123"');
    expect(res.body).not.toContain("postMessage(m,'*')");
  });

  // A grant holds a live loopback server bound to one upstream, reclaimed by an
  // idle sweep. Declining to *vouch* for a stranger is not enough if the
  // stranger can still keep the grant — and its upstream binding — alive long
  // after the pane closed, so `lastUsed` is refreshed for everyone except a
  // caller that has named itself as foreign.
  it.each([
    ['a foreign Origin does not refresh the grant', 'https://evil.example', false],
    ['an ordinary in-frame request, which carries no Origin, does', undefined, true],
  ])('%s', async (_name, origin, expectAlive) => {
    const port = await upstream((_q, s) => { s.writeHead(200, { 'content-type': 'text/plain' }); s.end('ok'); });
    const url = await frame(`http://127.0.0.1:${port}/`);
    const proxyPort = Number(new URL(url).port);

    advanceClock(4 * 60_000);
    const served = await request(url, {
      headers: { host: `127.0.0.1:${proxyPort}`, ...(origin ? { origin } : {}) },
    });
    expect(served.status).toBe(200); // served either way — admission is not the boundary

    advanceClock(2 * 60_000); // 6 min since the grant was made, 2 since the request
    await sweep();

    expect(await isListening(proxyPort)).toBe(expectAlive);
  });
});

describe('iframe proxy — the upgrade path', () => {
  // docs/specs/security-local.md -> "Loopback Listeners" singles this path out: WebSockets are not
  // subject to CORS, so a laundered Origin does not merely let a stranger
  // write, it hands them a readable socket to a dev server or
  // openvscode-server that would have refused their real origin. It had no
  // test at all until this one.
  let upstreamPort = 0;
  let url = '';
  let proxyPort = '';

  beforeEach(async () => {
    upstreamPort = await echoUpgradeUpstream();
    url = await frame(`http://127.0.0.1:${upstreamPort}/`);
    proxyPort = new URL(url).port;
  });

  const wsHeaders = (extra: Record<string, string>) => ({
    Host: `127.0.0.1:${proxyPort}`,
    Upgrade: 'websocket',
    Connection: 'Upgrade',
    'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==',
    'Sec-WebSocket-Version': '13',
    ...extra,
  });

  it('relabels the Origin of a page it served, and rewrites Host to the upstream', async () => {
    const seen = await upgrade(url, wsHeaders({ Origin: `http://127.0.0.1:${proxyPort}` }));

    expect(JSON.parse(seen)).toEqual({
      host: `127.0.0.1:${upstreamPort}`,
      origin: `http://127.0.0.1:${upstreamPort}`,
    });
  });

  it('forwards a foreign Origin untouched rather than laundering it', async () => {
    const seen = await upgrade(url, wsHeaders({ Origin: 'https://evil.example' }));

    expect(JSON.parse(seen).origin).toBe('https://evil.example');
  });

  it('leaves an absent Origin absent', async () => {
    const seen = await upgrade(url, wsHeaders({}));

    expect(JSON.parse(seen).origin).toBeNull();
  });

  it('destroys an upgrade addressed to a rebound hostile name', async () => {
    const seen = await upgrade(url, {
      ...wsHeaders({ Origin: 'https://evil.example' }),
      Host: 'evil.example:1234',
    });

    expect(seen).toBe('');
  });

  it('destroys an upgrade whose Host names another port', async () => {
    const seen = await upgrade(url, {
      ...wsHeaders({}),
      Host: `127.0.0.1:${Number(proxyPort) + 1}`,
    });

    expect(seen).toBe('');
  });

  it('answers nothing once the grant has been swept', async () => {
    advanceClock(6 * 60_000);
    await sweep();

    await expect(upgrade(url, wsHeaders({}))).rejects.toMatchObject({ code: 'ECONNREFUSED' });
  });
});

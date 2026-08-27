import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'node:http';
import { createIframeProxyUrl } from './iframe-proxy';

// Integration coverage for the Node proxy server (esbuild-only otherwise): we
// stand up a real loopback upstream, front it with createIframeProxyUrl, and
// fetch through the returned proxy URL — exercising the streaming shim
// injection, header rewriting, and error paths end to end.

const NO_LOG = { log: () => {} };
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

const upstreams: http.Server[] = [];
afterEach(() => {
  for (const s of upstreams.splice(0)) s.close();
});

function upstream(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  upstreams.push(server);
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const a = server.address();
    resolve(typeof a === 'object' && a ? a.port : 0);
  }));
}

interface Fetched { status: number; headers: http.IncomingHttpHeaders; body: string }
function get(url: string): Promise<Fetched> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    }).on('error', reject);
  });
}

async function frame(target: string): Promise<string> {
  const r = await createIframeProxyUrl(target, NO_LOG);
  if (!r.ok) throw new Error(`expected ok, got ${JSON.stringify(r)}`);
  return r.url;
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
    expect(res.headers['content-security-policy']).toBeUndefined();
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

  /** An upstream that reports back exactly what it was told about its caller. */
  function echoUpstream(): Promise<number> {
    return upstream((q, s) => {
      s.writeHead(200, { 'content-type': 'application/json' });
      s.end(JSON.stringify({ origin: q.headers.origin ?? null, host: q.headers.host ?? null }));
    });
  }

  function send(url: string, headers: Record<string, string>): Promise<Fetched> {
    const u = new URL(url);
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: u.hostname, port: u.port, path: '/', method: 'POST', headers }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  it('relabels the Origin of a page it served', async () => {
    const port = await echoUpstream();
    const url = await frame(`http://127.0.0.1:${port}/`);
    const proxyPort = new URL(url).port;

    const res = await send(url, { host: `127.0.0.1:${proxyPort}`, origin: `http://127.0.0.1:${proxyPort}` });

    // The legitimate iframe: origin-aware dev servers must see same-origin.
    expect(JSON.parse(res.body)).toEqual({ origin: `http://127.0.0.1:${port}`, host: `127.0.0.1:${port}` });
  });

  it('forwards a foreign Origin untouched instead of laundering it', async () => {
    const port = await echoUpstream();
    const url = await frame(`http://127.0.0.1:${port}/`);
    const proxyPort = new URL(url).port;

    const res = await send(url, { host: `127.0.0.1:${proxyPort}`, origin: 'https://evil.example' });

    // Forwarded, not blocked: the upstream sees the truth and applies its own
    // CSRF policy, so the proxy grants nothing that hitting the upstream port
    // directly would not.
    expect(JSON.parse(res.body).origin).toBe('https://evil.example');
    expect(JSON.parse(res.body).origin).not.toBe(`http://127.0.0.1:${port}`);
  });

  it('leaves an absent Origin absent (top-level navigation, same-origin GET)', async () => {
    const port = await echoUpstream();
    const url = await frame(`http://127.0.0.1:${port}/`);
    const proxyPort = new URL(url).port;

    const res = await send(url, { host: `127.0.0.1:${proxyPort}` });

    expect(JSON.parse(res.body).origin).toBeNull();
  });

  it('refuses a request addressed to a rebound hostile name', async () => {
    const port = await echoUpstream();
    const url = await frame(`http://127.0.0.1:${port}/`);

    // evil.example re-resolved to 127.0.0.1 arrives with its own name in Host,
    // and the browser treats the response as same-origin — so no CORS header
    // would get a say. 421 Misdirected Request, before the upstream is dialed.
    const res = await send(url, { host: 'evil.example:1234', origin: 'https://evil.example' });

    expect(res.status).toBe(421);
    expect(res.body).toBe('');
  });

  it('accepts either loopback spelling in Host', async () => {
    const port = await echoUpstream();
    const url = await frame(`http://127.0.0.1:${port}/`);
    const proxyPort = new URL(url).port;

    for (const host of [`127.0.0.1:${proxyPort}`, `localhost:${proxyPort}`]) {
      expect((await send(url, { host })).status).toBe(200);
    }
  });
});

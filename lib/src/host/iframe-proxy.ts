/**
 * Host-agnostic transparent proxy for the iframe surface
 * (docs/specs/dor-iframe.md → "The Transparent Proxy").
 *
 * Instead of pointing the `<iframe>` at a `dor iframe <url>` target directly —
 * where a cross-origin frame owns the keyboard, hides load errors, and can be
 * refused outright — the panel points it at a loopback proxy this module stands
 * up. Once Dormouse serves the bytes it can: (1) inject a fixed shim that
 * forwards the reserved leader chord back to the Wall, and (2) see the upstream
 * result and render a precise error *page* instead of a blank pane.
 *
 * This is the shared Node server, consumed by both hosts that can run one — the
 * VS Code extension host (`vscode-ext/src/iframe-proxy-host.ts`) and the Tauri
 * sidecar (bundled in via `standalone/scripts/build-sidecar-proxy.mjs`). Only
 * the policy/rewriting logic lives in `./iframe-proxy-rewrite` (pure, tested);
 * this file is the `http`/`net` plumbing. The logger is injected so neither host
 * has to depend on the other's logging.
 *
 * Sibling to the agent-browser stream relay: same loopback-only bind and
 * per-surface isolation, but this one speaks HTTP (parses and rewrites
 * responses) and passes WebSocket upgrades through (dev-server HMR,
 * openvscode-server).
 *
 * Per-surface isolation, two deliberate notes vs the spec's sketch:
 *   - Each grant gets its OWN ephemeral loopback server, so the grant's *origin*
 *     is the grant. That makes root-relative sub-resources (`/assets/x.js`) and
 *     absolute paths resolve and proxy transparently with zero body rewriting.
 *     A server bound to exactly one upstream is inherently not an open forwarder.
 *   - No token in the URL. It would land in `location.pathname` and break
 *     client-side routers (a React-Router/Remix dev server reads the path,
 *     matches no route, and renders its own 404). The dedicated server +
 *     loopback bind is the boundary instead.
 */
import * as http from 'http';
import * as net from 'net';
import type { IframeProxyResult } from '../lib/platform/iframe-proxy-types';
import {
  STRIP_RESPONSE_HEADERS,
  errorPageHtml,
  frameRefusedPage,
  instrumentHtml,
  isBlockedAddress,
  isLoopbackHost,
  refusesFraming,
  timedOutPage,
  unreachablePage,
  type ErrorPage,
} from './iframe-proxy-rewrite';

// Sliding idle TTL: a live iframe refreshes its grant on every request, so a
// grant only expires once its surface stops fetching (closed/killed). Lazy
// sweep on the next createIframeProxyUrl, like the stream relay.
const GRANT_IDLE_TTL_MS = 5 * 60_000;
const GRANT_SWEEP_MS = 60_000;
// Backstop against unbounded server accumulation if sweeps never run.
const MAX_GRANTS = 32;
const HTML_BODY_LIMIT = 32 * 1024 * 1024;
// Idle timeout on the upstream socket (no bytes flowing). Generous so a slow or
// streaming dev server isn't cut off, but bounded so a hung upstream becomes a
// visible error page instead of an indefinitely blank frame.
const UPSTREAM_IDLE_TIMEOUT_MS = 30_000;

/** Host-supplied logger; defaults to a no-op so the module is usable bare. */
export type ProxyLogger = (message: string) => void;
let log: ProxyLogger = () => {};

interface Grant {
  /** The fixed upstream this grant fronts (origin + initial path). */
  upstream: URL;
  isLoopback: boolean;
  port: number;
  proxyOrigin: string;
  server: http.Server;
  lastUsed: number;
}

const grants = new Map<number, Grant>();
let lastSweep = 0;

/**
 * Stand up a loopback proxy in front of `targetUrl` and return the URL the
 * panel should frame, or a structured reason it could not. The actual upstream
 * fetch happens lazily when the iframe loads the returned URL, so reachability
 * and frame-refusal surface as served error pages rather than here.
 */
export async function createIframeProxyUrl(
  targetUrl: string,
  opts?: { log?: ProxyLogger },
): Promise<IframeProxyResult> {
  if (opts?.log) log = opts.log;

  let upstream: URL;
  try {
    upstream = new URL(targetUrl);
  } catch {
    return { ok: false, reason: 'scheme', detail: 'not an absolute URL' };
  }
  // v1 proxies http:// upstreams only — loopback dev servers are overwhelmingly
  // plain http, and rewriting authenticated https pages is the agent-browser's
  // job (spec → Target policy).
  if (upstream.protocol !== 'http:') {
    return { ok: false, reason: 'scheme', detail: `${upstream.protocol.replace(':', '')} upstreams are not proxied yet` };
  }
  // SSRF guard: the proxy fetches a user-supplied URL, so refuse the link-local
  // / cloud-metadata ranges (169.254.169.254 and friends). Other private ranges
  // are trusted — the boundary is the user's own `dor iframe` (spec → Security).
  if (isBlockedAddress(upstream.hostname)) {
    return { ok: false, reason: 'scheme', detail: 'link-local / metadata addresses are refused' };
  }

  const now = Date.now();
  sweepGrants(now);

  const grant: Grant = {
    upstream,
    isLoopback: isLoopbackHost(upstream.hostname),
    port: 0,
    proxyOrigin: '',
    server: null as unknown as http.Server,
    lastUsed: now,
  };
  const server = http.createServer((req, res) => handleRequest(grant, req, res));
  server.on('upgrade', (req, socket, head) => handleUpgrade(grant, req, socket as net.Socket, head));
  server.on('error', (err) => log(`[iframe-proxy] server error: ${err.message}`));
  grant.server = server;

  let port: number;
  try {
    port = await listen(server);
  } catch (err) {
    return { ok: false, reason: 'unreachable', detail: err instanceof Error ? err.message : String(err) };
  }
  grant.port = port;
  grant.proxyOrigin = `http://127.0.0.1:${port}`;
  grants.set(port, grant);
  log(`[iframe-proxy] ${upstream.href} → ${grant.proxyOrigin} (loopback=${grant.isLoopback})`);

  // The proxy origin maps to one fixed upstream, so the full path resolves
  // transparently — keep the upstream's own initial path/search/hash so
  // deep-linked and hash-routed targets land where the user pointed. The hash is
  // browser-only; it is preserved in the iframe URL but never sent upstream.
  return { ok: true, url: `${grant.proxyOrigin}${upstream.pathname}${upstream.search}${upstream.hash}` };
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.unref();
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (address && typeof address === 'object') resolve(address.port);
      else reject(new Error('iframe proxy failed to bind'));
    });
  });
}

function handleRequest(grant: Grant, req: http.IncomingMessage, res: http.ServerResponse): void {
  grant.lastUsed = Date.now();
  const path = req.url ?? '/';

  const headers: http.OutgoingHttpHeaders = { ...req.headers };
  headers.host = grant.upstream.host;
  // Present the request as coming from the upstream's own origin so origin-aware
  // dev servers (Vary: Origin, CSRF checks) treat it as same-origin, and drop
  // Accept-Encoding so HTML comes back identity (we rewrite it).
  if (headers.origin) headers.origin = grant.upstream.origin;
  if (typeof headers.referer === 'string') headers.referer = headers.referer.split(grant.proxyOrigin).join(grant.upstream.origin);
  delete headers['accept-encoding'];

  const upstreamReq = http.request({
    protocol: 'http:',
    hostname: grant.upstream.hostname,
    port: grant.upstream.port || 80,
    method: req.method,
    path,
    headers,
  }, (upstreamRes) => {
    const contentType = String(upstreamRes.headers['content-type'] ?? '');
    if (!/text\/html/i.test(contentType)) {
      passThrough(grant, upstreamRes, res);
      return;
    }
    collectBody(upstreamRes, (body) => {
      // A remote that forbids embedding is never force-framed — serve an
      // actionable page that points at `dor ab` instead of a blank pane.
      if (!grant.isLoopback && refusesFraming(upstreamRes.headers)) {
        serveErrorPage(res, frameRefusedPage(grant.upstream));
        return;
      }
      const html = instrumentHtml(body);
      const outHeaders = sanitizeResponseHeaders(grant, upstreamRes.headers);
      outHeaders['content-type'] = 'text/html; charset=utf-8';
      outHeaders['content-length'] = Buffer.byteLength(html).toString();
      res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
      res.end(html);
    });
  });
  upstreamReq.on('error', (err) => {
    // Once we've begun streaming the response we can't swap in an error page —
    // just tear down. Otherwise serve an actionable page: distinguish "didn't
    // respond in time" (dev server busy/optimizing) from "couldn't connect"
    // (dev server down).
    if (res.headersSent || res.writableEnded) {
      res.destroy();
      return;
    }
    const code = (err as { code?: string }).code;
    serveErrorPage(res, code === 'ETIMEDOUT'
      ? timedOutPage(grant.upstream)
      : unreachablePage(grant.upstream, err.message));
  });
  // Fire on socket inactivity (not total duration), so active/streaming
  // responses are never cut off; a stalled upstream surfaces as a timeout page.
  upstreamReq.setTimeout(UPSTREAM_IDLE_TIMEOUT_MS, () => {
    upstreamReq.destroy(Object.assign(new Error('upstream timed out'), { code: 'ETIMEDOUT' }));
  });
  // If the frame navigates away or is closed, stop fetching upstream.
  res.on('close', () => { if (!res.writableEnded) upstreamReq.destroy(); });
  req.pipe(upstreamReq);
}

// Non-HTML upstream responses are forwarded verbatim apart from the stripped
// framing/hop-by-hop headers and a rewritten Location.
function passThrough(grant: Grant, upstreamRes: http.IncomingMessage, res: http.ServerResponse): void {
  const outHeaders = sanitizeResponseHeaders(grant, upstreamRes.headers);
  res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
  upstreamRes.pipe(res);
}

function collectBody(stream: http.IncomingMessage, done: (body: string) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > HTML_BODY_LIMIT) {
      stream.destroy();
      return;
    }
    chunks.push(chunk);
  });
  const complete = () => done(Buffer.concat(chunks).toString('utf8'));
  stream.on('end', complete);
  stream.on('error', complete);
}

function sanitizeResponseHeaders(grant: Grant, headers: http.IncomingHttpHeaders): http.OutgoingHttpHeaders {
  const out: http.OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    if (STRIP_RESPONSE_HEADERS.has(name.toLowerCase())) continue;
    out[name] = value;
  }
  // Keep upstream redirects on the proxy origin so they don't bounce the frame
  // straight at the un-instrumented upstream.
  const loc = out.location;
  if (typeof loc === 'string' && loc.startsWith(grant.upstream.origin)) {
    out.location = grant.proxyOrigin + loc.slice(grant.upstream.origin.length);
  }
  return out;
}

// --- WebSocket upgrade passthrough (dev-server HMR, openvscode-server) -------

// Mirrors the stream relay: once the upgrade head is rewritten (Host/Origin
// pointed at the upstream) the proxy is a dumb byte pipe.
function handleUpgrade(grant: Grant, req: http.IncomingMessage, socket: net.Socket, head: Buffer): void {
  grant.lastUsed = Date.now();
  socket.on('error', () => {});
  const path = req.url ?? '/';
  const targetPort = Number(grant.upstream.port) || 80;

  const upstream = net.connect(targetPort, grant.upstream.hostname, () => {
    const headerLines: string[] = [];
    for (let i = 0; i < req.rawHeaders.length; i += 2) {
      const name = req.rawHeaders[i];
      const lower = name.toLowerCase();
      if (lower === 'host') headerLines.push(`Host: ${grant.upstream.host}`);
      else if (lower === 'origin') headerLines.push(`Origin: ${grant.upstream.origin}`);
      else headerLines.push(`${name}: ${req.rawHeaders[i + 1]}`);
    }
    upstream.write(`GET ${path} HTTP/1.1\r\n${headerLines.join('\r\n')}\r\n\r\n`);
    if (head && head.length) upstream.write(head);
    socket.pipe(upstream);
    upstream.pipe(socket);
  });
  upstream.on('error', () => socket.destroy());
  socket.on('close', () => upstream.destroy());
}

function sweepGrants(now: number): void {
  if (now - lastSweep < GRANT_SWEEP_MS && grants.size < MAX_GRANTS) return;
  lastSweep = now;
  const ordered = [...grants.values()].sort((a, b) => a.lastUsed - b.lastUsed);
  for (const grant of ordered) {
    const expired = now - grant.lastUsed > GRANT_IDLE_TTL_MS;
    const overCap = grants.size > MAX_GRANTS;
    if (!expired && !overCap) break;
    grants.delete(grant.port);
    grant.server.close();
    log(`[iframe-proxy] swept grant for ${grant.upstream.href}`);
  }
}

function serveErrorPage(res: http.ServerResponse, page: ErrorPage): void {
  const html = instrumentHtml(errorPageHtml(page));
  res.writeHead(200, {
    'content-type': 'text/html; charset=utf-8',
    'content-length': Buffer.byteLength(html).toString(),
    'cache-control': 'no-store',
  });
  res.end(html);
}

/**
 * Extension-host transparent proxy for the iframe surface
 * (docs/specs/dor-iframe.md → "The Transparent Proxy").
 *
 * Instead of pointing the `<iframe>` at a `dor iframe <url>` target directly —
 * where a cross-origin frame owns the keyboard, hides load errors, and can be
 * refused outright — the panel points it at a loopback proxy this module stands
 * up. Once Dormouse serves the bytes it can: (1) inject a fixed shim that
 * forwards the reserved leader chord back to the Wall, and (2) see the upstream
 * result and render a precise error *page* instead of a blank pane.
 *
 * Sibling to the agent-browser `createStreamRelayUrl` (agent-browser-host.ts):
 * same loopback-only bind and per-surface isolation, but this one speaks HTTP —
 * it parses and rewrites responses rather than being a dumb byte pipe — and
 * passes WebSocket upgrades through (dev-server HMR, openvscode-server).
 *
 * Target policy (loopback instruments, remote diagnoses):
 *   - Loopback http upstream  → full instrument: strip X-Frame-Options, drop the
 *     page CSP, inject the shim. The user spawned it; framing is the intent.
 *   - Remote http, frameable  → forward with the shim (flagged that `dor ab` is
 *     the better tool for arbitrary browsing).
 *   - Remote http, refuses    → never strip; serve a Dormouse error page that
 *     points at `dor ab open <url>`.
 *   - Unreachable             → serve a Dormouse error page.
 * `https://` upstreams are deferred (loopback dev servers are overwhelmingly
 * plain http); the panel reports `scheme` and falls back to a hint.
 *
 * Per-surface isolation, two deliberate notes vs the spec's sketch:
 *   - Each grant gets its OWN ephemeral loopback server, so the grant's *origin*
 *     is the grant. That makes root-relative sub-resources (`/assets/x.js`) and
 *     absolute paths resolve and proxy transparently with zero body rewriting
 *     (the one thing a shared `…/<token>/<path>` origin can't do — Open
 *     Decision #2). A server bound to exactly one upstream is inherently not an
 *     open forwarder, which is what the token grant bought the stream relay.
 *   - No token in the URL. It would land in `location.pathname` and break
 *     client-side routers (a React-Router/Remix dev server reads the path,
 *     matches no route, and renders its own 404). The dedicated server +
 *     loopback bind is the boundary instead.
 */
import * as http from 'http';
import * as net from 'net';
import { log } from './log';
import type { IframeProxyResult } from '../../lib/src/lib/platform/types';

// Sliding idle TTL: a live iframe refreshes its grant on every request, so a
// grant only expires once its surface stops fetching (closed/killed). Lazy
// sweep on the next createIframeProxyUrl, like the stream relay.
const GRANT_IDLE_TTL_MS = 5 * 60_000;
const GRANT_SWEEP_MS = 60_000;
// Backstop against unbounded server accumulation if sweeps never run.
const MAX_GRANTS = 32;
const HTML_BODY_LIMIT = 32 * 1024 * 1024;

// Hop-by-hop headers (RFC 7230 §6.1) plus framing headers we manage ourselves.
// Never forwarded downstream.
const STRIP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
  // Framing controls — stripped so the proxy origin (which the webview frames)
  // never inherits a "do not embed" from the upstream. For loopback that is the
  // whole point; for a frameable remote there is nothing to strip anyway, and a
  // refusing remote is diverted to an error page before we get here.
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
]);

// The fixed, Dormouse-owned shim — like agent-browser's EDIT_SCRIPTS, never
// user-supplied, so it is not an eval vector. Injected inline into served HTML
// (loopback CSP is dropped, so an inline script runs). It reclaims ONLY the
// reserved leader chord (dual-tap ⌘ / ⇧, matching handle-dual-tap.ts) and posts
// it to the Wall; every other keystroke flows to the tool untouched. The focus
// model needs no message channel — `document.hasFocus()` already stays true
// while a descendant frame holds focus (resolves #2), and the Wall focuses the
// frame element directly (resolves #3).
const IFRAME_SHIM = `(function(){
  var P=window.parent;
  if(!P||P===window)return;
  function tap(s,e){
    var now=Date.now(),side=e.location===1?'left':'right';
    if(s.side==='left'&&side==='right'&&now-s.time<500){s.side=null;return true;}
    s.side=side;s.time=now;return false;
  }
  function leader(){try{P.postMessage({__dormouse:'leader'},'*');}catch(e){}}
  var cmd={side:null,time:0},shift={side:null,time:0};
  addEventListener('keydown',function(e){
    if(e.key==='Meta'){if(tap(cmd,e))leader();}
    else if(e.key==='Shift'){if(tap(shift,e))leader();}
  },true);
})();`;

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
export async function createIframeProxyUrl(targetUrl: string): Promise<IframeProxyResult> {
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
  server.on('error', (err) => log.info(`[iframe-proxy] server error: ${err.message}`));
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
  log.info(`[iframe-proxy] ${upstream.href} → ${grant.proxyOrigin} (loopback=${grant.isLoopback})`);

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
    collectBody(upstreamRes, (body, truncated) => {
      // A remote that forbids embedding is never force-framed — serve an
      // actionable page that points at `dor ab` instead of a blank pane.
      if (!grant.isLoopback && refusesFraming(upstreamRes.headers)) {
        serveErrorPage(res, frameRefusedPage(grant.upstream));
        return;
      }
      // An over-limit body can't be safely instrumented (the shim may land past
      // the cutoff, and serving half a document is worse than an honest error).
      if (truncated) {
        serveErrorPage(res, bodyTooLargePage(grant.upstream));
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
  upstreamReq.on('error', (err) => serveErrorPage(res, unreachablePage(grant.upstream, err.message)));
  req.pipe(upstreamReq);
}

// Non-HTML upstream responses are forwarded verbatim apart from the stripped
// framing/hop-by-hop headers and a rewritten Location.
function passThrough(grant: Grant, upstreamRes: http.IncomingMessage, res: http.ServerResponse): void {
  const outHeaders = sanitizeResponseHeaders(grant, upstreamRes.headers);
  res.writeHead(upstreamRes.statusCode ?? 200, outHeaders);
  upstreamRes.pipe(res);
}

function collectBody(stream: http.IncomingMessage, done: (body: string, truncated: boolean) => void): void {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  stream.on('data', (chunk: Buffer) => {
    size += chunk.length;
    if (size > HTML_BODY_LIMIT) {
      truncated = true;
      stream.destroy();
      return;
    }
    chunks.push(chunk);
  });
  const complete = () => done(Buffer.concat(chunks).toString('utf8'), truncated);
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

// Drop any in-document CSP (loopback "relax CSP") and inject the shim before
// </head> so it runs before the tool's own scripts. The response-header CSP is
// already stripped in sanitizeResponseHeaders.
function instrumentHtml(body: string): string {
  const html = body.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    '',
  );
  const shimTag = `<script>${IFRAME_SHIM}</script>`;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${shimTag}</head>`);
  if (/<body[^>]*>/i.test(html)) return html.replace(/(<body[^>]*>)/i, `$1${shimTag}`);
  return shimTag + html;
}

// A remote refuses framing if it sends any X-Frame-Options or a CSP
// frame-ancestors that is not the permissive standalone `*`. Conservative on
// purpose: when in doubt we divert to an error page rather than show a
// guaranteed-blank frame.
function refusesFraming(headers: http.IncomingHttpHeaders): boolean {
  if (headers['x-frame-options']) return true;
  const csp = headers['content-security-policy'];
  const policies = Array.isArray(csp) ? csp : csp ? [csp] : [];
  return policies.some((policy) => hasRestrictiveFrameAncestors(policy));
}

function hasRestrictiveFrameAncestors(policy: string): boolean {
  const directives = policy.split(';');
  for (const directive of directives) {
    const parts = directive.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0].toLowerCase() !== 'frame-ancestors') continue;
    const sources = parts.slice(1);
    if (!sources.includes('*')) return true;
  }
  return false;
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

// --- Policy helpers ----------------------------------------------------------

function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

function isBlockedAddress(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv4 link-local / cloud metadata (169.254.0.0/16, incl. 169.254.169.254).
  if (/^169\.254\./.test(h)) return true;
  // IPv6 link-local (fe80::/10).
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
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
    log.info(`[iframe-proxy] swept grant for ${grant.upstream.href}`);
  }
}

// --- Served error / diagnostic pages ----------------------------------------

interface ErrorPage {
  title: string;
  message: string;
  hint?: string;
}

function frameRefusedPage(upstream: URL): ErrorPage {
  return {
    title: `${upstream.host} refuses to be embedded`,
    message: `${upstream.host} sends a frame-blocking header (X-Frame-Options or CSP frame-ancestors), so it can’t be shown in an iframe surface.`,
    hint: `dor ab open ${upstream.href}`,
  };
}

function bodyTooLargePage(upstream: URL): ErrorPage {
  const limit = `${Math.round(HTML_BODY_LIMIT / (1024 * 1024))} MB`;
  return {
    title: `${upstream.host} sent too much HTML`,
    message: `The HTML response from ${upstream.href} exceeded HTML_BODY_LIMIT of ${limit}, so it couldn’t be instrumented and shown in an iframe surface.`,
    hint: `dor ab open ${upstream.href}`,
  };
}

function unreachablePage(upstream: URL, detail: string): ErrorPage {
  return {
    title: `Nothing responding at ${upstream.host}`,
    message: `Dormouse couldn’t reach ${upstream.href} (${detail}). Is the dev server running?`,
  };
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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function errorPageHtml(page: ErrorPage): string {
  const hint = page.hint
    ? `<p class="hint">Try <code>${escapeHtml(page.hint)}</code></p>`
    : '';
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: dark; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center;
    background: #14161a; color: #c9ced6;
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { max-width: 34rem; padding: 1.5rem 2rem; text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.05rem; font-weight: 600; color: #e7ebf1; }
  p { margin: .5rem 0; }
  .hint { margin-top: 1rem; }
  code { background: #20242b; border-radius: 4px; padding: .15rem .4rem;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace; color: #e7ebf1; }
</style></head>
<body><div class="card">
  <h1>${escapeHtml(page.title)}</h1>
  <p>${escapeHtml(page.message)}</p>
  ${hint}
</div></body></html>`;
}

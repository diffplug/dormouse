/**
 * Pure, dependency-free helpers for the iframe transparent proxy
 * (docs/specs/dor-iframe.md → "The Transparent Proxy").
 *
 * Split out from the Node server (`iframe-proxy.ts`) so the policy/rewriting
 * logic is shared by every host that runs the proxy (VS Code extension host,
 * Tauri sidecar) and is unit-testable without standing up a server. Nothing
 * here imports `http`/`net`; headers are typed structurally so this file is
 * runtime-agnostic.
 */

/** Header bag shape both `http.IncomingHttpHeaders` and a plain map satisfy. */
export type ProxyHeaders = Record<string, string | string[] | undefined>;

// Hop-by-hop headers (RFC 7230 §6.1) plus framing headers we manage ourselves.
// Never forwarded downstream.
export const STRIP_RESPONSE_HEADERS = new Set([
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
// (loopback CSP is dropped, so an inline script runs). It posts two things to
// the Wall and nothing else (every other keystroke flows to the tool):
//   - `leader`: the reserved dual-tap ⌘/⇧ chord (matching handle-dual-tap.ts),
//     so the global chord keeps working with the frame focused (#1).
//   - `pointerdown`: a click landed in the frame. A cross-origin click reaches
//     only the frame, so the Wall can't see it; this lets it select the pane /
//     enter passthrough (#3). It's genuine user input, so it can't loop with the
//     parent's programmatic focus.
//   - `location`: the proxied frame's current URL. The parent converts it back
//     to the upstream URL and uses it to keep iframe Back/Forward/Reload chrome
//     honest.
export const IFRAME_SHIM = `(function(){
  var P=window.parent;
  if(!P||P===window)return;
  function post(t,d){try{var m={__dormouse:t};if(d)for(var k in d)m[k]=d[k];P.postMessage(m,'*');}catch(e){}}
  function postLocation(){post('location',{url:String(location.href)});}
  function anchorHref(e){
    var n=e&&e.target;
    while(n&&n.nodeType===1){
      if(n.tagName&&String(n.tagName).toLowerCase()==='a'&&n.href)return n;
      n=n.parentElement;
    }
    return null;
  }
  function tap(s,e){
    var now=Date.now(),side=e.location===1?'left':'right';
    if(s.side==='left'&&side==='right'&&now-s.time<500){s.side=null;return true;}
    s.side=side;s.time=now;return false;
  }
  var cmd={side:null,time:0},shift={side:null,time:0};
  addEventListener('keydown',function(e){
    if(e.key==='Meta'){if(tap(cmd,e))post('leader');}
    else if(e.key==='Shift'){if(tap(shift,e))post('leader');}
  },true);
  addEventListener('pointerdown',function(){post('pointerdown');},true);
  addEventListener('click',function(e){
    var a=anchorHref(e);
    if(!a||a.hasAttribute('download'))return;
    if(a.target&&a.target!=='_self'){
      // New-tab/window link: the iframe renderer is single-frame, so hand the
      // URL to Dormouse to open as a new pane instead of letting it vanish.
      e.preventDefault();
      post('open-window',{url:String(a.href)});
      return;
    }
    // Modifier / non-primary clicks (Cmd/Ctrl/Shift/Alt, middle button) open a
    // new tab/window and leave this frame put — don't report a location the
    // frame isn't actually showing, or the parent's URL bar + Back history lie.
    if(e.metaKey||e.ctrlKey||e.shiftKey||e.altKey||e.button!==0)return;
    post('location',{url:String(a.href)});
  },true);
  // window.open is likewise single-frame-hostile; redirect it to a new pane.
  try{window.open=function(u){
    var url='';try{url=u?String(new URL(String(u),location.href)):'';}catch(_e){url=String(u||'');}
    post('open-window',{url:url});
    return null;
  };}catch(_e){}
  addEventListener('popstate',postLocation,true);
  addEventListener('hashchange',postLocation,true);
  addEventListener('pageshow',postLocation,true);
  var H=history;
  if(H&&H.pushState&&H.replaceState){
    var p=H.pushState,r=H.replaceState;
    H.pushState=function(){var v=p.apply(this,arguments);setTimeout(postLocation,0);return v;};
    H.replaceState=function(){var v=r.apply(this,arguments);setTimeout(postLocation,0);return v;};
  }
  if(document.readyState==='loading')addEventListener('DOMContentLoaded',postLocation,{once:true});
  else setTimeout(postLocation,0);
})();`;

// Drop any in-document CSP (loopback "relax CSP") and inject the shim before
// </head> so it runs before the tool's own scripts. The response-header CSP is
// stripped separately via STRIP_RESPONSE_HEADERS.
export function instrumentHtml(body: string): string {
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
export function refusesFraming(headers: ProxyHeaders): boolean {
  if (headers['x-frame-options']) return true;
  const csp = headers['content-security-policy'];
  const policies = Array.isArray(csp) ? csp : csp ? [csp] : [];
  return policies.some((policy) => hasRestrictiveFrameAncestors(policy));
}

export function hasRestrictiveFrameAncestors(policy: string): boolean {
  const directives = policy.split(';');
  for (const directive of directives) {
    const parts = directive.trim().split(/\s+/).filter(Boolean);
    if (parts.length === 0 || parts[0].toLowerCase() !== 'frame-ancestors') continue;
    const sources = parts.slice(1);
    if (!sources.includes('*')) return true;
  }
  return false;
}

export function isLoopbackHost(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.startsWith('127.');
}

export function isBlockedAddress(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  // IPv4 link-local / cloud metadata (169.254.0.0/16, incl. 169.254.169.254).
  if (/^169\.254\./.test(h)) return true;
  // IPv6 link-local (fe80::/10).
  if (/^fe[89ab][0-9a-f]:/.test(h)) return true;
  return false;
}

// --- Served error / diagnostic pages ----------------------------------------

export interface ErrorPage {
  title: string;
  message: string;
  hint?: string;
}

export function frameRefusedPage(upstream: URL): ErrorPage {
  return {
    title: `${upstream.host} refuses to be embedded`,
    message: `${upstream.host} sends a frame-blocking header (X-Frame-Options or CSP frame-ancestors), so it can’t be shown in an iframe surface.`,
    hint: `dor ab open ${upstream.href}`,
  };
}

export function unreachablePage(upstream: URL, detail: string): ErrorPage {
  return {
    title: `Nothing responding at ${upstream.host}`,
    message: `Dormouse couldn’t reach ${upstream.href} (${detail}). Is the dev server running?`,
  };
}

export function timedOutPage(upstream: URL): ErrorPage {
  return {
    title: `${upstream.host} isn’t responding`,
    message: `Dormouse connected to ${upstream.host} but it didn’t respond in time — the dev server may be busy (e.g. optimizing dependencies). Try reloading.`,
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

export function errorPageHtml(page: ErrorPage): string {
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

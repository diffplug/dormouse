/**
 * Pure, dependency-free helpers for the iframe transparent proxy
 * (docs/specs/dor-browser.md → "Iframe Renderer").
 *
 * Split out from the Node server (`iframe-proxy.ts`) so the policy/rewriting
 * logic is shared by every host that runs the proxy (VS Code extension host,
 * Tauri sidecar) and is unit-testable without standing up a server. Nothing
 * here imports `http`/`net`; headers are typed structurally so this file is
 * runtime-agnostic.
 */

import { ipv4Value, isLoopbackHostname } from '../lib/ip-literal';

/** Header bag shape both `http.IncomingHttpHeaders` and a plain map satisfy. */
export type ProxyHeaders = Record<string, string | string[] | undefined>;

// Hop-by-hop headers (RFC 7230 §6.1). Never forwarded downstream.
export const HOP_BY_HOP_RESPONSE_HEADERS = new Set([
  'connection', 'keep-alive', 'proxy-authenticate', 'proxy-authorization',
  'te', 'trailer', 'transfer-encoding', 'upgrade',
]);

/**
 * The upstream's framing controls.
 *
 * **Dropped only when the proxy replaces them with its own `frame-ancestors`.**
 * Dropping them for everyone is what once made this listener a privilege: the
 * loopback port is not a secret, and neither `Origin` (absent on a navigation)
 * nor `Sec-Fetch-Site` (`cross-site` for our webview and for an attacker page
 * alike) can tell the two embedders apart at request time. So the recognizer
 * cannot be a request header — it is the *embedder* that has to be named, and
 * `frame-ancestors` is the mechanism browsers already enforce for exactly that
 * question. The replacement also admits `'self'`: documents already inside one
 * fixed-upstream grant may frame each other, which is required by apps such as
 * Storybook whose preview is a nested iframe. A stranger's foreign ancestor
 * still never matches; without a known app embedder origin the upstream's own
 * "do not embed" is forwarded untouched.
 */
export const FRAMING_RESPONSE_HEADERS = new Set([
  'x-frame-options', 'content-security-policy', 'content-security-policy-report-only',
]);

/** Upstreams that supply their own content boundary opt into retaining it.
 * This only preserves restrictions; it grants no additional authority. */
export const PRESERVE_CSP_HEADER = 'x-dormouse-preserve-csp';

// A serialized origin: scheme, host, optional port, nothing else. Deliberately
// strict — the value ends up inside a CSP header we emit, so anything that
// could carry a `;` or a space is refused rather than escaped. It covers the
// origins the shipped webviews actually have (`vscode-webview://<uuid>`,
// `vscode-file://vscode-app`, `tauri://localhost`, `http://tauri.localhost`).
const SERIALIZED_ORIGIN_RE = /^[a-z][a-z0-9+.-]*:\/\/[a-z0-9.-]+(?::[0-9]{1,5})?$/;
const MAX_EMBEDDER_ORIGINS = 8;

/**
 * The ancestor chain a proxied frame is allowed to sit in, or `null` when it
 * cannot be established.
 *
 * `frame-ancestors` is checked against **every** ancestor, not just the parent,
 * so the caller supplies its whole chain (`location.origin` plus
 * `location.ancestorOrigins`) — VS Code nests the extension's document two
 * frames deep inside the workbench. All-or-nothing on purpose: a chain missing
 * one entry would block Dormouse's own frame, so an unparseable or opaque
 * ancestor (`"null"`) means no chain at all, and the proxy then vouches for
 * nobody rather than guessing.
 */
export function normalizeEmbedderOrigins(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_EMBEDDER_ORIGINS) return null;
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry !== 'string') return null;
    const origin = entry.toLowerCase();
    if (!SERIALIZED_ORIGIN_RE.test(origin)) return null;
    if (!out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * The proxy's framing policy, replacing or supplementing the upstream's CSP.
 * `'self'` permits nested documents within this one per-grant origin; every
 * external ancestor must still be in the validated app chain.
 */
export function frameAncestorsCsp(embedderOrigins: string[]): string {
  return `frame-ancestors 'self' ${embedderOrigins.join(' ')}`;
}

// The fixed, Dormouse-owned shim — like agent-browser's EDIT_SCRIPTS, never
// user-supplied, so it is not an eval vector. Injected inline into served HTML;
// this is why the default drops upstream CSP whole rather than per-directive (an
// inline script needs `script-src` gone as much as the frame needs
// `frame-ancestors` gone). It posts four message kinds to the Wall and nothing
// else (every other keystroke flows to the tool). A nested document relays the
// three pane-level kinds through its same-origin proxy parents until the outer
// document reaches the app; its document-level location stays inside the outer
// frame:
//   - `leader`: the reserved dual-tap ⌘/⇧ chord (matching handle-dual-tap.ts),
//     so the global chord keeps working with the frame focused.
//   - `pointerdown`: a click landed in the frame. A cross-origin click reaches
//     only the frame, so the Wall can't see it; this lets it select the pane /
//     enter passthrough. It's genuine user input, so it can't loop with the
//     parent's programmatic focus.
//   - `location`: the proxied frame's current URL. The parent converts it back
//     to the upstream URL and uses it to keep iframe Back/Forward/Reload chrome
//     honest.
//   - `open-window`: an anchor with any target but `_self` (`_blank`, `_top`,
//     `_parent`, a named frame) or a `window.open` the single-frame renderer
//     can't honor; the parent offers it as a new pane instead.
export function iframeShim(embedderOrigin: string): string {
  return `(function(){
  var P=window.parent;
  var TARGET=${JSON.stringify(embedderOrigin)};
  if(!P||P===window)return;
  // Address each hop to the proxy's own origin and the app origin, never '*'.
  // Exactly one matches: a nested frame reaches its same-origin parent, while
  // the outer frame reaches the app. Relays accept only the three pane-level
  // shapes below, so unrelated same-origin application messages and a nested
  // document's location never escape.
  function send(m){try{P.postMessage(m,location.origin);}catch(e){}try{P.postMessage(m,TARGET);}catch(e){}}
  function post(t,d){var m={__dormouse:t};if(d)for(var k in d)m[k]=d[k];send(m);}
  addEventListener('message',function(e){
    if(e.origin!==location.origin)return;
    var d=e.data,t=d&&d.__dormouse;
    if(t==='leader'||t==='pointerdown')post(t);
    else if(t==='open-window'&&typeof d.url==='string')post(t,{url:d.url});
  },true);
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
    // This is the capture phase, before the page's own handlers. Defer a tick
    // and bail if the page cancelled the click (preventDefault, or an <a> that
    // fetches instead of navigating) — else we'd report a navigation that never
    // happened. A real navigation re-reports via the next document's shim, so
    // nothing is lost if this frame is torn down before the tick fires.
    var href=String(a.href);
    setTimeout(function(){if(!e.defaultPrevented)post('location',{url:href});},0);
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
}

// Drop in-document CSP unless the upstream opted into preservation, then
// inject the shim before </head>. Applies to framed http upstreams, loopback or
// remote — the trade is stated in docs/specs/dor-browser.md → "Iframe Host
// Capability And CSP". The response-header CSP is replaced separately via
// FRAMING_RESPONSE_HEADERS.
//
// `embedderOrigin` is the document that frames us, and it is required: without
// one there is nobody to address the shim's messages to, so the caller must not
// instrument at all rather than fall back to `'*'`.
const HEAD_CLOSE = /<\/head>/i;
const BODY_OPEN = /<body[^>]*>/i;

/** The end of the document prefix `instrumentHtml` places the shim before
 *  (`</head>`) or after (`<body…>`). The proxy buffers until it sees one. */
export const HEAD_MARKER = new RegExp(`${HEAD_CLOSE.source}|${BODY_OPEN.source}`, 'i');

export function instrumentHtml(body: string, embedderOrigin: string, preserveCsp = false): string {
  const html = preserveCsp ? body : body.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    '',
  );
  const shimTag = `<script>${iframeShim(embedderOrigin)}</script>`;
  if (HEAD_CLOSE.test(html)) return html.replace(HEAD_CLOSE, (tag) => shimTag + tag);
  if (BODY_OPEN.test(html)) return html.replace(BODY_OPEN, (tag) => tag + shimTag);
  // Both tags are optional in valid HTML. Never ahead of the doctype, which
  // would switch the page to quirks mode, nor of a `<meta charset>`, which
  // counts only within the first 1024 bytes — the same window searched here.
  const prologue = html.slice(0, 1024);
  let at = 0;
  for (const tag of [/<!doctype[^>]*>/i, /<html(?:\s[^>]*)?>/i, /<head(?:\s[^>]*)?>/i, /<meta\b[^>]*\bcharset\b[^>]*>/i]) {
    const match = tag.exec(prologue);
    if (match) at = Math.max(at, match.index + match[0].length);
  }
  return html.slice(0, at) + shimTag + html.slice(at);
}

// 169.254.0.0/16 — IPv4 link-local, incl. the 169.254.169.254 cloud-metadata
// endpoint — as a numeric range so every equivalent encoding is caught.
const LINK_LOCAL_V4_START = 0xa9fe0000; // 169.254.0.0
const LINK_LOCAL_V4_END = 0xa9feffff; // 169.254.255.255

export function isBlockedAddress(hostname: string): boolean {
  // IPv6 link-local (fe80::/10).
  if (/^\[?fe[89ab][0-9a-f]:/i.test(hostname)) return true;
  // Resolve the host to its 32-bit IPv4 value across every equivalent encoding
  // (decimal/octal/hex, short forms, IPv4-mapped IPv6) and range-check the
  // link-local / cloud-metadata block. The genuine end-to-end hole a literal
  // 169.254.* match leaves is the IPv6-embedded form (::ffff:169.254.169.254),
  // which the WHATWG URL parser normalizes to a hex-group spelling the regex
  // can't see; the numeric-IPv4 spellings are collapsed by that same parser
  // before the guard runs, so canonicalizing them here is defense-in-depth
  // against callers that don't pre-normalize rather than a live bypass fix.
  const v4 = ipv4Value(hostname);
  return v4 !== null && v4 >= LINK_LOCAL_V4_START && v4 <= LINK_LOCAL_V4_END;
}

// --- Served error / diagnostic pages ----------------------------------------

export interface ErrorPage {
  title: string;
  message: string;
}

export function unreachablePage(upstream: URL, detail: string): ErrorPage {
  return {
    title: `Nothing responding at ${upstream.host}`,
    message: `Dormouse couldn’t reach ${upstream.href} (${detail}). ${isLoopbackHostname(upstream.hostname)
      ? 'Is the dev server running?'
      : 'Check that the server is up and reachable from this machine.'}`,
  };
}

export function timedOutPage(upstream: URL): ErrorPage {
  return {
    title: `${upstream.host} isn’t responding`,
    message: `Dormouse connected to ${upstream.host} but it didn’t respond in time — ${isLoopbackHostname(upstream.hostname)
      ? 'the dev server may be busy (e.g. optimizing dependencies)'
      : 'the server may be busy or slow'}. Try reloading.`,
  };
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// The page is a separate document on the proxy origin, out of reach of the
// app's theme tokens, so it follows the system scheme through CSS system
// colors rather than hardcoding either one.
export function errorPageHtml(page: ErrorPage): string {
  return `<!doctype html><html><head><meta charset="utf-8">
<style>
  :root { color-scheme: light dark; }
  html, body { height: 100%; margin: 0; }
  body { display: flex; align-items: center; justify-content: center;
    background: Canvas; color: color-mix(in srgb, CanvasText 75%, Canvas);
    font: 14px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
  .card { max-width: 34rem; padding: 1.5rem 2rem; text-align: center; }
  h1 { margin: 0 0 .5rem; font-size: 1.05rem; font-weight: 600; color: CanvasText; }
  p { margin: .5rem 0; }
</style></head>
<body><div class="card">
  <h1>${escapeHtml(page.title)}</h1>
  <p>${escapeHtml(page.message)}</p>
</div></body></html>`;
}

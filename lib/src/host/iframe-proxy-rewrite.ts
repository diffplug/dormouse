/**
 * Pure, dependency-free helpers for the iframe transparent proxy
 * (docs/specs/dor-browser.md → "Iframe Renderer").
 *
 * Split out from the Node server (`iframe-proxy.ts`) so the policy/rewriting
 * logic is shared by every host that runs the proxy (VS Code extension host,
 * Tauri sidecar) and is unit-testable without standing up a server. Nothing
 * here imports `http`/`net`.
 */

import { dualTap, newDualTapState } from '../lib/dual-tap';
import { bareAddress, ipv4Value, ipv4sCarriedByIPv6, ipv6Bytes, isLoopbackHostname } from '../lib/ip-literal';

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
 * The owner prefix of a lease a remote session holds for its frame
 * (`docs/specs/remote-api.md` → "Frames"): the session releases it, and no
 * window sweep does.
 */
export const REMOTE_LEASE_OWNER_PREFIX = 'remote:';

/**
 * `value` with an exact parsed `from` origin replaced by `to`, path, query, and
 * fragment kept. Compares parsed origins, never string prefixes or embedded
 * query values, so a foreign redirect or referer keeps its authority and its
 * payload intact; a relative or malformed value passes through unchanged.
 */
export function rewriteOrigin(value: string, from: string, to: string): string {
  try {
    const url = new URL(value);
    if (url.origin === from) return `${to}${url.pathname}${url.search}${url.hash}`;
  } catch { /* Relative Locations and malformed headers pass through unchanged. */ }
  return value;
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
// `frame-ancestors` gone). It posts five message kinds to the Wall and nothing
// else (every other keystroke flows to the tool). A nested document relays the
// three pane-level kinds through its same-origin proxy parents until the outer
// document reaches the app; its document-level location stays inside the outer
// frame:
//   - `leader`: the reserved dual-tap ⌘/⇧ chord, detected by the Wall's own
//     `dualTap` embedded as source, so the global chord keeps working with the
//     frame focused.
//   - `pointerdown`: a click landed in the frame. A cross-origin click reaches
//     only the frame, so the Wall can't see it; this lets it select the pane /
//     enter passthrough. The app hears it only from a frame holding focus, since
//     the page can post it too, so the frame takes focus first: a page that
//     cancels the press would otherwise get none from the browser.
//   - `location`: the proxied frame's current URL. The parent converts it back
//     to the upstream URL and uses it to keep iframe Back/Forward/Reload chrome
//     honest. `nav` says how it changed: `push` (a link, `pushState`, or a
//     fragment change), `replace` (`replaceState`), or `traverse` (`popstate`,
//     the page moving through its own history); a load report carries
//     `loaded: true` instead.
//   - `open-window`: an anchor with any target but `_self` (`_blank`, `_top`,
//     `_parent`, a named frame) or a `window.open` the single-frame renderer
//     can't honor; the parent offers it as a new pane instead.
//   - `theme-request`: the document loaded and wants the app's theme; it stays
//     in the outer document.
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
  // Only the embedding app can publish a theme. These are data values passed
  // to CSSOM, never a stylesheet or executable markup. A Tool's own selectors
  // and controls remain its own; only the webview variable surface is exposed.
  var KINDS=['vscode-light','vscode-dark','vscode-high-contrast','vscode-high-contrast-light'];
  var VAR=/^--vscode-[a-zA-Z0-9-]+$/;
  var themeKeys=[],themeApplied='';
  addEventListener('message',function(e){
    var d=e.data;
    if(e.source!==P||e.origin!==TARGET||!d||d.__dormouse!=='theme'||!d.vars)return;
    if(KINDS.indexOf(d.kind)<0||(d.scheme!=='light'&&d.scheme!=='dark'))return;
    var keys=Object.keys(d.vars).filter(function(k){return VAR.test(k)&&typeof d.vars[k]==='string';});
    var roots=[document.documentElement,document.body].filter(Boolean);
    // Load repeats the request; restyle only when the theme or the roots change.
    var applied=roots.length+JSON.stringify([d.kind,d.scheme,keys.map(function(k){return [k,d.vars[k]];})]);
    if(applied===themeApplied)return;
    themeApplied=applied;
    roots.forEach(function(root){
      themeKeys.forEach(function(k){root.style.removeProperty(k);});
      keys.forEach(function(k){root.style.setProperty(k,d.vars[k]);});
      KINDS.forEach(function(k){root.classList.toggle(k,k===d.kind);});
      root.style.colorScheme=d.scheme;
    });
    themeKeys=keys;
    dispatchEvent(new CustomEvent('dormouse:theme'));
  });
  post('theme-request');
  addEventListener('message',function(e){
    if(e.origin!==location.origin)return;
    var d=e.data,t=d&&d.__dormouse;
    if(t==='leader'||t==='pointerdown')post(t);
    else if(t==='open-window'&&typeof d.url==='string')post(t,{url:d.url});
  },true);
  function postLocation(nav){post('location',{url:String(location.href),nav:nav});}
  // The document's own load, flagged: the parent takes only these as proof
  // that the document it just loaded carries the shim.
  function postLoaded(){post('location',{url:String(location.href),loaded:true});post('theme-request');}
  function anchorHref(e){
    var n=e&&e.target;
    while(n&&n.nodeType===1){
      if(n.tagName&&String(n.tagName).toLowerCase()==='a'&&n.href)return n;
      n=n.parentElement;
    }
    return null;
  }
  // Bound by position: a minifier may rename the function itself.
  var dualTap=${dualTap},taps=(${newDualTapState})();
  addEventListener('keydown',function(e){if(dualTap(taps,e))post('leader');},true);
  addEventListener('pointerdown',function(){if(!document.hasFocus())window.focus();post('pointerdown');},true);
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
    setTimeout(function(){if(!e.defaultPrevented)post('location',{url:href,nav:'push'});},0);
  },true);
  // window.open is likewise single-frame-hostile; redirect it to a new pane.
  try{window.open=function(u){
    var url='';try{url=u?String(new URL(String(u),location.href)):'';}catch(_e){url=String(u||'');}
    post('open-window',{url:url});
    return null;
  };}catch(_e){}
  addEventListener('popstate',function(){postLocation('traverse');},true);
  // A traversal fires popstate before hashchange, so this repeats the URL just
  // reported, which the parent's current entry already holds.
  addEventListener('hashchange',function(){postLocation('push');},true);
  addEventListener('pageshow',postLoaded,true);
  var H=history;
  if(H&&H.pushState&&H.replaceState){
    var p=H.pushState,r=H.replaceState;
    H.pushState=function(){var v=p.apply(this,arguments);setTimeout(function(){postLocation('push');},0);return v;};
    H.replaceState=function(){var v=r.apply(this,arguments);setTimeout(function(){postLocation('replace');},0);return v;};
  }
  if(document.readyState==='loading')addEventListener('DOMContentLoaded',postLoaded,{once:true});
  else setTimeout(postLoaded,0);
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
// Every WHATWG label for UTF-16 (LE and BE): a body in either is no place to
// splice ASCII bytes.
const UTF16_LABELS = new Set(['utf-16', 'utf-16le', 'utf-16be', 'unicode', 'unicodefeff', 'unicodefffe', 'ucs-2', 'iso-10646-ucs-2', 'csunicode']);

/** Whether a `Content-Type` declares a UTF-16 charset. */
export function declaresUtf16(contentType: string): boolean {
  const charset = /;\s*charset\s*=\s*["']?([^"';\s]+)/i.exec(contentType)?.[1];
  return !!charset && UTF16_LABELS.has(charset.toLowerCase());
}

/** Whether a body opens with a UTF-16 byte-order mark, which the browser's
 *  sniff obeys over any header. */
export function startsWithUtf16Bom(bytes: Uint8Array): boolean {
  return bytes.length >= 2 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || (bytes[0] === 0xfe && bytes[1] === 0xff));
}

const HEAD_CLOSE = /<\/head>/i;
/** A tag's attributes, whose quoted values may hold a `>`. */
const ATTRIBUTES = String.raw`(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?`;
const BODY_OPEN = new RegExp(`<body${ATTRIBUTES}>`, 'i');

/** The end of the document prefix `instrumentHtml` places the shim before
 *  (`</head>`) or after (`<body…>`). The proxy buffers until it sees one. */
export const HEAD_MARKER = new RegExp(`${HEAD_CLOSE.source}|${BODY_OPEN.source}`, 'i');

/**
 * For a page a remote Client frames (`docs/specs/remote-api.md` → "Frames"): no
 * service worker sees a WebSocket, so a same-origin one goes as a message to the
 * worker controlling this page, which relays it (`lib/src/remote/frame-origin/`).
 * A socket on any other origin, or a page no worker controls, stays native. A
 * send is taken at the call, as a native one is, and a Blob goes as it is for the
 * far end to read, so everything is on the port in order even as the page goes.
 * A page going away closes what it holds: nothing else tells the session, whose
 * sockets are few.
 */
export function tunnelSocketShim(): string {
  return `(function(){
  var N=window.WebSocket,S=navigator.serviceWorker,L=new Set();
  if(!N||!S||!S.controller)return;
  addEventListener('pagehide',function(){L.forEach(function(end){end();});});
  class T extends EventTarget{constructor(url,protocols){
    var u=new URL(String(url),location.href);
    if(u.host!==location.host)return protocols===undefined?new N(url):new N(url,protocols);
    super();
    var t=this;
    t.url=u.href;t.protocol='';t.extensions='';t.bufferedAmount=0;t.binaryType='blob';t.readyState=0;
    t.onopen=t.onmessage=t.onclose=t.onerror=null;
    function fire(ev){t.dispatchEvent(ev);var h=t['on'+ev.type];if(typeof h==='function')h.call(t,ev);}
    var c=new MessageChannel(),p=c.port1;
    function end(code,reason){if(L.delete(end))p.postMessage({kind:'close',code:code,reason:reason});}
    L.add(end);
    p.onmessage=function(m){
      var d=m.data;
      if(d.kind==='open'){if(t.readyState!==0)return;t.readyState=1;t.protocol=d.protocol;t.extensions=d.extensions;fire(new Event('open'));}
      else if(d.kind==='sent'){t.bufferedAmount-=d.bytes;}
      else if(d.kind==='message'){
        var v=d.binary?(t.binaryType==='arraybuffer'?d.data:new Blob([d.data])):new TextDecoder().decode(d.data);
        fire(new MessageEvent('message',{data:v,origin:location.origin}));
      }else if(d.kind==='closed'){
        if(d.code===1006)fire(new Event('error'));
        t.readyState=3;L.delete(end);p.close();
        fire(new CloseEvent('close',{code:d.code,reason:d.reason,wasClean:d.code!==1006}));
      }
    };
    t.send=function(data){
      if(t.readyState===0)throw new DOMException('Still in CONNECTING state.','InvalidStateError');
      if(t.readyState!==1)return;
      var k=Object.prototype.toString.call(data),v=ArrayBuffer.isView(data),l=k==='[object Blob]'||k==='[object File]',b=v||l||k==='[object ArrayBuffer]';
      var m=l?data:v?data.buffer.slice(data.byteOffset,data.byteOffset+data.byteLength):b?data.slice(0):new TextEncoder().encode(String(data)).buffer;
      t.bufferedAmount+=l?m.size:m.byteLength;
      p.postMessage({kind:'send',data:m,binary:b},l?[]:[m]);
    };
    t.close=function(code,reason){
      if(code!==undefined&&code!==1000&&(code<3000||code>4999))throw new DOMException('Invalid close code.','InvalidAccessError');
      if(reason!==undefined&&new TextEncoder().encode(reason).length>123)throw new DOMException('Close reason too long.','SyntaxError');
      if(t.readyState>1)return;
      t.readyState=2;end(code,reason);
    };
    var list=protocols===undefined?[]:typeof protocols==='string'?[protocols]:Array.prototype.slice.call(protocols);
    S.controller.postMessage({kind:'socket',path:u.pathname+u.search,protocols:list},[c.port2]);
  }}
  var states={CONNECTING:0,OPEN:1,CLOSING:2,CLOSED:3};
  Object.assign(T,states);Object.assign(T.prototype,states);
  window.WebSocket=T;
})();`;
}

export function instrumentHtml(body: string, embedderOrigin: string, preserveCsp = false, tunneled = false): string {
  const html = preserveCsp ? body : body.replace(
    /<meta[^>]+http-equiv=["']?content-security-policy["']?[^>]*>/gi,
    '',
  );
  const shimTag = `<script>${iframeShim(embedderOrigin)}</script>`;
  // Ahead of the page's own scripts, which may open a socket as they run.
  const at = prologueEnd(html);
  const page = tunneled ? `${html.slice(0, at)}<script>${tunnelSocketShim()}</script>${html.slice(at)}` : html;
  if (HEAD_CLOSE.test(page)) return page.replace(HEAD_CLOSE, (tag) => shimTag + tag);
  if (BODY_OPEN.test(page)) return page.replace(BODY_OPEN, (tag) => tag + shimTag);
  // Both tags are optional in valid HTML.
  return page.slice(0, at) + shimTag + page.slice(at);
}

/**
 * One thing that may stand in a page's first kilobyte, comments and whitespace
 * before it. A script only passes for a charset behind it, which the shim must
 * not push out of that kilobyte.
 */
const PROLOGUE_TOKEN = new RegExp(String.raw`\s*(<!--[\s\S]*?-->|<!doctype[^>]*>|<(?:html|head|meta|link|base)${ATTRIBUTES}>|<(title|style|script)${ATTRIBUTES}>[\s\S]*?</\2\s*>)`, 'giy');
/** Of those, what a script ahead of it would break. */
const MUST_PRECEDE_SCRIPT = /^(?:<!doctype|<html|<head|<meta\b[\s\S]*\bcharset\b)/i;

/**
 * The earliest a script may go. Never ahead of the doctype, which would switch
 * the page to quirks mode, nor of a `<meta charset>`, which counts only within
 * the first 1024 bytes — the same window searched here.
 */
function prologueEnd(html: string): number {
  const prologue = html.slice(0, 1024);
  // Nor ahead of a UTF-8 BOM (its latin1 spelling), which must stay first.
  const start = html.startsWith('\xEF\xBB\xBF') ? 3 : 0;
  let at = start;
  // Walked from the start, stopping at the first thing that is no token: a tag's
  // spelling inside a script's text is not a tag.
  for (const token of prologue.slice(start).matchAll(PROLOGUE_TOKEN)) {
    if (MUST_PRECEDE_SCRIPT.test(token[1]!)) at = start + token.index + token[0].length;
  }
  return at;
}

// Metadata endpoints outside IPv4 link-local, each one host in a block that also
// holds ordinary machines, so the address and not the block.
const CLOUD_METADATA_V4 = new Set([
  '100.100.100.200', // Alibaba Cloud
  '192.0.0.192', // Oracle Cloud
  '168.63.129.16', // Azure
].map((address) => ipv4Value(address)));
const CLOUD_METADATA_V6 = new Set([
  'fd00:ec2::254', // AWS
  'fd20:ce::254', // Google Cloud
].map((address) => ipv6Bytes(address)!.join()));


/** One spelling per address: an IPv4 one, mapped into IPv6 or not, as its number. */
function addressKey(address: string): string | number {
  const bare = bareAddress(address);
  return ipv4Value(bare) ?? bare;
}

/**
 * Whether a connection to a resolved address reaches this machine: loopback, the
 * unspecified address a server bound to every interface prints, or one of
 * `interfaceAddresses`, which this host's interfaces hold. Takes an address and
 * never a name: `localhost` is whatever the resolver says it is.
 */
export function isThisMachineAddress(address: string, interfaceAddresses: readonly string[]): boolean {
  const key = addressKey(address);
  const loopback = typeof key === 'number' ? key >>> 24 === 127 : key === '::1';
  if (loopback || key === 0 || key === '::') return true;
  return interfaceAddresses.some((held) => addressKey(held) === key);
}

function isBlockedIPv4(value: number): boolean {
  // 169.254.0.0/16, the cloud-metadata endpoint's own range among them.
  return value >>> 16 === 0xa9fe || CLOUD_METADATA_V4.has(value);
}

/**
 * Whether a host names a link-local or cloud-metadata address, in any spelling:
 * every IPv4 encoding (decimal/octal/hex, short forms), and every IPv6 literal
 * that names one or reaches one through a translator. The WHATWG URL
 * parser collapses the numeric IPv4 spellings before this guard runs, but a
 * resolver's answer and a caller that did not parse have not been through it.
 */
export function isBlockedAddress(hostname: string): boolean {
  const v6 = ipv6Bytes(hostname);
  if (v6) {
    const linkLocal = v6[0] === 0xfe && (v6[1] & 0xc0) === 0x80; // fe80::/10
    return linkLocal || CLOUD_METADATA_V6.has(v6.join()) || ipv4sCarriedByIPv6(v6).some(isBlockedIPv4);
  }
  const v4 = ipv4Value(hostname);
  return v4 !== null && isBlockedIPv4(v4);
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

/** What a frame sees in place of a redirect off its grant's upstream origin,
 *  which the webview's loopback-only `frame-src` would refuse as a blank pane. */
export function offOriginRedirectPage(target: URL): ErrorPage {
  return {
    title: `Redirected to ${target.origin}`,
    message: `This page redirected to ${target.href}, outside this preview.`,
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
//
// `navigate`, when given, is a URL the page goes to in its place. The pane's own
// frame asks the embedding panel, addressed to `embedderOrigin` only, which
// takes it as a URL-bar entry, so the external-origin gate applies
// (docs/specs/dor-browser.md → "Iframe External Origins"). A frame nested in a
// proxied page — its parent readable, on the same proxy origin — is outside the
// webview's `frame-src`, so it follows the redirect itself, as it would have.
// `from` is the redirecting URL, so the panel replaces that history entry
// rather than leave one that redirects again on Back.
export function errorPageHtml(page: ErrorPage, navigate?: { url: string; embedderOrigin: string }): string {
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
</div>${navigate ? `<script>(function(){var U=${scriptJson(navigate.url)};
try{if(parent.location.origin===location.origin){location.replace(U);return;}}catch(e){}
try{parent.postMessage({__dormouse:'navigate',url:U,from:String(location.href)},${scriptJson(navigate.embedderOrigin)});}catch(e){}})();</script>` : ''}</body></html>`;
}

// JSON for an inline <script>: `<` escaped so no value can close the element.
function scriptJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c');
}

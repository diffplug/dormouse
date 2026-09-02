/**
 * The origins of the documents that frame Dormouse's own UI, innermost first.
 *
 * The iframe proxy needs this to say who may frame it (`frame-ancestors`), and
 * the shim needs the first entry as its `postMessage` target
 * (`lib/src/host/iframe-proxy-rewrite.ts`). Neither can be decided in the host:
 * the webview's origin is `vscode-webview://<per-window uuid>` or
 * `tauri://localhost`, known only in the realm that has a `location`.
 *
 * **The whole chain, not just this window.** `frame-ancestors` is checked
 * against every ancestor, and VS Code nests the extension's document two frames
 * deep inside the workbench — so a list holding only `location.origin` would
 * block Dormouse's own frame. `ancestorOrigins` is a Chromium/WebKit API and
 * both shipped hosts are one of those; where it is missing or reports an opaque
 * `"null"` ancestor, the host refuses the chain outright and serves the
 * upstream's own framing headers with no shim, which is the safe degradation.
 */
export function embedderOrigins(): string[] {
  if (typeof location === 'undefined') return [];
  const chain = [location.origin];
  const ancestors = location.ancestorOrigins;
  if (ancestors) {
    for (let i = 0; i < ancestors.length; i += 1) chain.push(ancestors[i]);
  }
  return chain.filter((origin, index) => origin && chain.indexOf(origin) === index);
}

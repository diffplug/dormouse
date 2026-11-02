// Sandbox every framed page, proxied or raw, so a tool's
// `if (top !== self) top.location = …` framebust cannot navigate the Wall away —
// allow-top-navigation is omitted on purpose (docs/specs/security-local.md →
// "Browser panes"). Everything else a local dev tool needs is granted;
// allow-same-origin is safe because the frame's origin (the loopback proxy, or
// the upstream itself on a host with no proxy) is never same-origin with the
// host webview — except the website playground's first-party viewer pages,
// which it serves from its own origin over a fixed snapshot
// (docs/specs/tutorial.md -> Playground filesystem). **The raw fallback is not
// the trusted case** — it is the one with no proxy in front of it at all, so it
// gets the same sandbox rather than none.
export { IFRAME_SANDBOX } from 'remote-lib-common';
// Permissions-Policy for the framed page. `dor iframe` takes any http(s) URL,
// not only a loopback dev server, and a desktop webview often has no per-site
// permission prompt (WKWebView with no media `WKUIDelegate`, WebView2
// defaults) — so a grant here is a grant, not a request. Camera, microphone,
// geolocation and `clipboard-read` are therefore **not** granted:
// `clipboard-read` most pointedly, since a terminal's clipboard is where users
// paste secrets. Writing to the clipboard needs a user gesture and cannot read.
export const IFRAME_ALLOW = 'autoplay; clipboard-write; fullscreen';

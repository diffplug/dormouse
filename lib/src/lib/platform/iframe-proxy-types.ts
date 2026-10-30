/**
 * Result of asking the host to front a `dor iframe` target with its transparent
 * proxy (docs/specs/dor-browser.md → "Iframe Renderer"). On `ok` the panel
 * points the `<iframe>` at `url` — a loopback proxy origin that fetches the
 * target, strips frame-blocking headers (any http upstream), and injects the
 * Dormouse shim. On failure `reason` says why there is nothing to frame:
 * `scheme` — the upstream can't be proxied: a non-absolute URL, a non-`http://`
 * target (e.g. an `https://` URL, which v1 defers), or an `http://` upstream
 * whose name resolves to an address the SSRF guard refuses (link-local /
 * cloud-metadata); the `detail` field carries the specific cause.
 * `external` — the upstream resolves to an address off this machine and the
 * request did not say the user allowed its origin (`IframeProxyOptions`).
 * `unreachable` — the name did not resolve, or no proxy could be stood up. Whether
 * the upstream answers is diagnosed lazily and surfaced as a served error *page*
 * inside the frame. A framed site's
 * frame-blocking headers are stripped, not obeyed.
 *
 * Kept in its own dependency-free file so the Node proxy in `lib/src/host/`
 * can import it without dragging the browser-typed `platform/types` graph into
 * a Node tsconfig (and vice-versa).
 */
/** Why a host with the iframe proxy refuses an `https://` page — the one
 *  wording the proxy, the panel, the Display modal, a render swap and
 *  `surface.iframe` share. The `surface.iframe` refusal and the panel's error
 *  name `dor agent-browser open <url>` as the remedy; the Display modal shows
 *  the bare wording, and a render swap only warns in the console. */
export const IFRAME_HTTP_ONLY = 'the embedded view frames http:// pages only';

export type IframeProxyResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'unreachable' | 'scheme' | 'external'; detail?: string };

/** `allowExternal`: the user allowed the target's exact origin, so an
 *  upstream off this machine may be proxied (docs/specs/dor-browser.md →
 *  "Iframe External Origins"). */
export type IframeProxyOptions = { allowExternal?: boolean };

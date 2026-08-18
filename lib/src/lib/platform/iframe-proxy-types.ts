/**
 * Result of asking the host to front a `dor iframe` target with its transparent
 * proxy (docs/specs/dor-browser.md → "Iframe Renderer"). On `ok` the panel
 * points the `<iframe>` at `url` — a loopback proxy origin that fetches the
 * target, strips frame-blocking headers (any http upstream), and injects the
 * Dormouse shim. On failure `reason` says why there is nothing to frame:
 * `scheme` — the upstream can't be proxied: a non-absolute URL, a non-`http://`
 * target (e.g. an `https://` URL, which v1 defers), or an `http://` address
 * refused by the SSRF guard (link-local / cloud-metadata); the `detail` field
 * carries the specific cause. `unreachable` — nothing answered. Reachability is
 * normally diagnosed lazily and surfaced as a served error *page* inside the
 * frame, so v1 mostly returns `ok` or `scheme` here. A framed site's
 * frame-blocking headers are stripped, not obeyed.
 *
 * Kept in its own dependency-free file so the Node proxy in `lib/src/host/`
 * can import it without dragging the browser-typed `platform/types` graph into
 * a Node tsconfig (and vice-versa).
 */
export type IframeProxyResult =
  | { ok: true; url: string }
  | { ok: false; reason: 'unreachable' | 'scheme'; detail?: string };

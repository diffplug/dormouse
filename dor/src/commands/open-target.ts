/**
 * Browser-open target resolution shared by `dor iframe` and `dor ab open`.
 *
 * Both entry points accept, wherever they take an absolute URL:
 *  - a terminal Surface handle (`surface:N`, `surface:<stable-id>`,
 *    `surface:self`, `surface:focused`) — resolved to the dev server it owns via
 *    the host port scan (`surface.resolveOpen`), collapsing the
 *    `dor list --ports` → `dor ab open http://localhost:<port>` dance;
 *  - a bare `:port` — sugar for a localhost URL (`:5173` → `http://localhost:5173/`);
 *  - a schemeless `host:port` — inferred to `http://` (`localhost:5173`,
 *    `box.ts.net:3000`, `192.168.1.5:8080`). The explicit port is the signal
 *    that this is a dev/infra server, which is http far more often than not
 *    (loopback, LAN containers, Tailnet peers); public HTTPS lives on 443 with
 *    no port. An explicit scheme is always honored, so `https://…` still works.
 *
 * A plain URL is normalized/forwarded unchanged. See docs/specs/dor-cli.md
 * (Browser Open Target Resolution) and docs/specs/dor-browser.md.
 */

import type { ControlClient, ParseResult } from './types.js';

declare const URL: {
  new(input: string): { href: string; protocol: string };
};

// A bare `:port` (optionally trailed by a path/query/hash) — localhost sugar.
const BARE_PORT = /^:\d{1,5}(?:[/?#].*)?$/;
// A schemeless host:port (optional path): `localhost:5173`, `box.ts.net:3000`,
// `192.168.1.5:8080`, `[::1]:5173`. The absence of `//` keeps this from matching
// an absolute URL (`http://…`), which flows through the URL path with its scheme.
const HOST_PORT = /^(?:[A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}(?:[/?#].*)?$/;

/** A dor Surface handle used as a browser-open target: `surface:N`,
 *  `surface:<stable-id>`, `surface:self`, or `surface:focused`. Every form
 *  carries the `surface:` prefix, which a real URL never does. */
export function isSurfaceOpenTarget(target: string): boolean {
  return target.startsWith('surface:');
}

/**
 * Infer an `http://` URL for a schemeless `:port` / `host:port` target — the
 * forms dor defaults to http (a bare `:port` is localhost). Returns a canonical
 * URL (`http://localhost:5173/`), or null when `target` is neither form.
 */
export function inferredHttpUrl(target: string): string | null {
  const prefixed = BARE_PORT.test(target)
    ? `http://localhost${target}`
    : HOST_PORT.test(target)
      ? `http://${target}`
      : null;
  if (prefixed === null) return null;
  try {
    return new URL(prefixed).href;
  } catch {
    return null;
  }
}

/** A target dor resolves/normalizes itself before it becomes a URL the browser
 *  surface can open — a Surface handle, a bare `:port`, or a schemeless
 *  `host:port`. A URL with an explicit scheme is not special and is forwarded
 *  verbatim. */
export function isSpecialOpenTarget(target: string): boolean {
  return isSurfaceOpenTarget(target) || inferredHttpUrl(target) !== null;
}

/**
 * Normalize a concrete (non-Surface) browser-open target to a URL: a schemeless
 * `:port` / `host:port` (inferred to http), or an absolute http(s) URL. Throws
 * `SyntaxError` for anything else — a non-http(s) scheme, or an input that is
 * neither a URL nor a `host:port`.
 */
export function normalizeConcreteOpenUrl(target: string): string {
  const inferred = inferredHttpUrl(target);
  if (inferred) return inferred;

  let url: { href: string; protocol: string };
  try {
    url = new URL(target);
  } catch {
    throw new SyntaxError('URL must be an absolute http:// or https:// URL, a host:port, or a :port');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SyntaxError('URL must use http:// or https://');
  }
  return url.href;
}

/**
 * Resolve a Surface-handle open target to its dev-server URL via the host port
 * scan (`surface.resolveOpen`). The host groups listening records by port and
 * fails clearly on zero or multiple candidate ports; that failure surfaces here
 * as the returned message.
 */
export async function resolveSurfaceOpenTarget(
  target: string,
  client: ControlClient,
): Promise<ParseResult<string>> {
  try {
    const { url } = await client.resolveOpenTarget({ surface: target });
    return { ok: true, value: url };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : String(error) };
  }
}

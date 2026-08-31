/** Target normalization shared by `dor iframe` and `dor ab open`; see
 * docs/specs/dor-cli.md → "Browser Open Target Resolution". */

import { errorMessage } from './shared.js';
import type { ControlClient, ParseResult } from './types.js';

declare const URL: {
  new(input: string): { href: string; protocol: string };
};

// A bare `:port` (optionally trailed by a path/query/hash) — localhost sugar.
const BARE_PORT = /^:\d{1,5}(?:[/?#].*)?$/;
// A schemeless host:port (optional path): `localhost:5173`, `box.ts.net:3000`,
// `192.168.1.5:8080`, `[::1]:5173`. The host is captured (group 1) so a
// bare-integer host can be rejected in inferredHttpUrl. The absence of `//`
// keeps this from matching an absolute URL (`http://…`), which flows through the
// URL path with its scheme.
const HOST_PORT = /^([A-Za-z0-9._-]+|\[[0-9A-Fa-f:]+\]):\d{1,5}(?:[/?#].*)?$/;

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
  let prefixed: string | null = null;
  if (BARE_PORT.test(target)) {
    prefixed = `http://localhost${target}`;
  } else {
    const hostPort = HOST_PORT.exec(target);
    // A purely numeric "host" (e.g. `800`) is never a hostname — `new URL` packs
    // it into a bogus IPv4 (`http://800:600` → `http://0.0.3.32:600/`). Reject it
    // so `dor ab open`'s shape-scan can't rewrite a stray `n:n`-shaped flag value
    // into a URL. A real IPv4 (`192.168.1.5`) has dots and is kept.
    if (hostPort && !/^\d+$/.test(hostPort[1])) prefixed = `http://${target}`;
  }
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
    return { ok: false, message: errorMessage(error) };
  }
}

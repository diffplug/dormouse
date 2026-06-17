/**
 * Small URL helpers for the agent-browser surface header
 * (see docs/specs/dor-agent-browser.md → "Browser-chrome header").
 *
 * The header shows a tab's URL as host+path (Chrome-style, the scheme and any
 * query/hash dropped) and, when that URL is loopback, correlates its port to a
 * Dormouse terminal pane. Both jobs are pure string parsing kept out of the
 * components so they can be unit-tested directly.
 */

/** Host + path of a URL (e.g. `localhost:5173/app`), the header's primary text.
 *  Falls back to the raw string for anything `URL` can't parse. */
export function hostPathDisplay(rawUrl: string): string {
  try {
    const parsed = new URL(rawUrl);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return `${parsed.host}${path}` || rawUrl;
  } catch {
    return rawUrl || '';
  }
}

/** Path only (e.g. `/app`), used when a dev-server chip already shows the
 *  host+port so the domain would be redundant. Falls back to the raw string for
 *  anything `URL` can't parse. */
export function pathDisplay(rawUrl: string): string {
  try {
    return new URL(rawUrl).pathname || '/';
  } catch {
    return rawUrl || '';
  }
}

/** Turn a typed address-bar value into a navigable URL: keep an explicit scheme,
 *  otherwise add one — `http://` for loopback hosts (a bare `localhost:5173`
 *  speaks http, and `https` there just SSL-errors), `https://` for everything
 *  else. Empty input ⇒ '' (caller skips navigation). */
export function normalizeNavUrl(raw: string): string {
  const trimmed = raw.trim();
  if (!trimmed) return '';
  // A hierarchical scheme (http://, https://, file://, …) or a known schemeless
  // one (about:, data:, mailto:, …) — leave it be. A bare `host:port` such as
  // `localhost:5173` is NOT a scheme (no `//`), so it falls through to get one.
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\//.test(trimmed)) return trimmed;
  if (/^(about|data|blob|mailto|tel|javascript|view-source|chrome):/i.test(trimmed)) return trimmed;
  const hostname = trimmed.split(/[/?#]/, 1)[0].split(':', 1)[0];
  return `${isLoopbackHostname(hostname) ? 'http' : 'https'}://${trimmed}`;
}

/** True for hostnames that resolve to the local machine. `*.localhost` is
 *  included because browsers route it to loopback per the RFC. */
function isLoopbackHostname(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host === '[::1]' ||
    host.endsWith('.localhost')
  );
}

/** The TCP port of a loopback URL, or null if the URL is not loopback / has no
 *  resolvable port. Defaults the port from the scheme (http→80, https→443) so a
 *  bare `http://localhost` still correlates. */
export function loopbackPort(rawUrl: string): number | null {
  try {
    const parsed = new URL(rawUrl);
    if (!isLoopbackHostname(parsed.hostname)) return null;
    const port = parsed.port
      ? Number(parsed.port)
      : parsed.protocol === 'https:'
        ? 443
        : parsed.protocol === 'http:'
          ? 80
          : NaN;
    return Number.isInteger(port) && port > 0 && port <= 65535 ? port : null;
  } catch {
    return null;
  }
}

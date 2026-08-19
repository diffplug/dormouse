/**
 * Where a Host is allowed to reach a relay server, enforced in the process that
 * holds the socket (docs/specs/server.md → "Host webview CSP").
 *
 * The allowlist is written as a CSP source list because that is what it used to
 * be: while the Host lived in a webview, `connect-src` was the enforcement. A
 * Node-resident Host has no CSP, so the same source list is baked into its
 * bundle and checked here instead — one syntax, one build-time variable
 * (`DORMOUSE_REMOTE_CONNECT_SRC`), whichever process ends up holding the socket.
 *
 * Matching is deliberately narrower than a browser's: only the sources a Host
 * can meaningfully be pointed at (scheme + host + port) are understood, and
 * anything else fails closed.
 */

/**
 * The remote-server sources baked into published builds. Kept equal to
 * `scripts/csp-defaults.mjs` by `connect-src.test.ts` — the build scripts read
 * the `.mjs`, the service reads this, and a drift between them would ship a
 * binary that refuses the origin its own CSP allows.
 */
export const DEFAULT_REMOTE_CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';

/** Substituted by esbuild at build time; see `scripts/csp-defaults.mjs`. */
declare const __DORMOUSE_REMOTE_CONNECT_SRC__: string;

/**
 * The allowlist this build was compiled with — the one place the baked value is
 * read, whichever process holds the socket.
 *
 * A `define` substitutes the identifier wherever it appears in the bundle,
 * imported lib modules included, and both host bundles pass it
 * (`standalone/scripts/build-sidecar-proxy.mjs`, `vscode-ext/scripts/esbuild.mjs`),
 * so declaring it here rather than at each entry point keeps the value a literal
 * in the bundle with no second copy of the fallback to drift. The `typeof` guard
 * is for the test runners, which have no define.
 */
export function bakedConnectSrc(): string {
  return typeof __DORMOUSE_REMOTE_CONNECT_SRC__ === 'string'
    ? __DORMOUSE_REMOTE_CONNECT_SRC__
    : DEFAULT_REMOTE_CONNECT_SRC;
}

/** https and wss are one scheme to a Host: the relay is reached over both. */
function schemeClass(scheme: string): 'secure' | 'insecure' | null {
  if (scheme === 'https:' || scheme === 'wss:') return 'secure';
  if (scheme === 'http:' || scheme === 'ws:') return 'insecure';
  return null;
}

function defaultPort(schemeGroup: 'secure' | 'insecure'): string {
  return schemeGroup === 'secure' ? '443' : '80';
}

interface ParsedSource {
  group: 'secure' | 'insecure';
  host: string;
  /** `*` means any port; otherwise the literal port the source names. */
  port: string;
}

function parseSource(source: string): ParsedSource | null {
  const match = /^([a-z][a-z0-9+.-]*:)\/\/([^/:]+)(?::(\*|\d+))?$/i.exec(source);
  if (!match) return null;
  const group = schemeClass(match[1]!.toLowerCase());
  if (!group) return null;
  return {
    group,
    host: match[2]!.toLowerCase(),
    port: match[3] ?? defaultPort(group),
  };
}

/**
 * A source's host matches exactly, or by a leading-`*.` wildcard that covers
 * every sub-domain at any depth but never the bare domain itself — `*.x.y`
 * reaches `a.x.y` and `a.b.x.y`, not `x.y`. That is CSP's rule, and the
 * shipped default depends on it: per-tenant subdomains of `dormouse.sh` are in
 * scope while `dormouse.sh` itself is not.
 */
function hostMatches(sourceHost: string, host: string): boolean {
  // `*.x.y` -> the suffix `.x.y`, which `x.y` itself cannot end with.
  if (sourceHost.startsWith('*.')) return host.endsWith(sourceHost.slice(1));
  return sourceHost === host;
}

/**
 * Whether `origin` is one this build's Host may connect to. `sources` is a
 * whitespace-separated CSP source list; an unparseable origin or source is
 * never a match.
 */
export function originAllowedByConnectSrc(origin: string, sources: string): boolean {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  const group = schemeClass(url.protocol);
  if (!group || url.hostname === '') return false;
  const host = url.hostname.toLowerCase();
  const port = url.port || defaultPort(group);

  for (const raw of sources.split(/\s+/)) {
    if (!raw) continue;
    const source = parseSource(raw);
    if (!source) continue;
    if (source.group !== group) continue;
    if (!hostMatches(source.host, host)) continue;
    if (source.port !== '*' && source.port !== port) continue;
    return true;
  }
  return false;
}

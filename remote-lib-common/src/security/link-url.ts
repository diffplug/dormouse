/**
 * The checks every link a phone opens into this app shares, before its fragment
 * is read (`docs/specs/relay.md` → "Setup tokens and the pairing QR").
 *
 * A link's payload rides in the fragment, which never reaches a server, so the
 * URL around it is the only thing that says which deployment the payload is
 * for. One helper, so every link grammar refuses the same URLs in the same
 * order: a second copy of these rules would be a second chance to accept a code
 * aimed at someone else's origin.
 */

/**
 * The three origins the documented dev loop serves the app from, and the whole
 * of the HTTPS exemption. **Matched by exact host, and deliberately narrower
 * than the platform's own secure-context rule**, which also trusts
 * `*.localhost` and all of `127.0.0.0/8`: this is a policy list, not a
 * re-derivation, so widening it is a decision rather than a correction.
 * `URL.hostname` spells the IPv6 loopback bracketed, so that is the form here.
 */
export const LINK_LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Where one link grammar puts its payload, and how long a whole link may be. */
export interface LinkUrlShape {
  /**
   * The longest link accepted, compared before the URL is parsed: a megabyte
   * of camera text must cost a length compare, not a parse.
   */
  readonly maxLength: number;
  /** The exact path the link must carry. */
  readonly pathname: string;
  /** The hash prefix the fragment must lead with, `#` included. */
  readonly hashPrefix: string;
}

/**
 * `new URL`, or `null`. Written as a helper rather than a `let url: URL` so the
 * type is inferred: this package compiles with `"types": []`, where `URL` is a
 * value without a global type name.
 */
function parseUrl(text: string) {
  try {
    return new URL(text);
  } catch {
    return null;
  }
}

/**
 * **HTTPS, or plain HTTP on one of {@link LINK_LOOPBACK_HOSTS}.** Every one of
 * those is a secure context by the platform's own rule, so the exemption admits
 * no origin WebAuthn or a service worker would refuse to run on.
 */
export function isLinkScheme(url: { readonly protocol: string; readonly hostname: string }): boolean {
  return url.protocol === 'https:' || (url.protocol === 'http:' && LINK_LOOPBACK_HOSTS.has(url.hostname));
}

/**
 * The fragment of one link into this app, after `shape.hashPrefix`, or `null`
 * where the URL around it is not one this app may take.
 *
 * `appOrigin` is the origin the running app is served from, and the link's must
 * equal it exactly: a fragment is invisible to every server, so the only thing
 * that keeps a code from bootstrapping a *different* deployment is this compare.
 * Nothing about the fragment itself is checked here; its grammar is the
 * caller's.
 */
export function parseLinkFragment(text: unknown, appOrigin: string, shape: LinkUrlShape): string | null {
  if (typeof text !== 'string' || text.length > shape.maxLength) return null;
  const url = parseUrl(text);
  if (!url) return null;
  // The origin compare below still has to pass, so this widens nothing a
  // remote code could reach — see {@link LINK_LOOPBACK_HOSTS}.
  if (!isLinkScheme(url)) return null;
  // Credentials in the authority would let a code name an origin the compare
  // below accepts while the browser navigates somewhere else entirely.
  if (url.username !== '' || url.password !== '') return null;
  if (url.pathname !== shape.pathname || url.search !== '') return null;
  if (url.origin !== appOrigin) return null;
  if (!url.hash.startsWith(shape.hashPrefix)) return null;
  return url.hash.slice(shape.hashPrefix.length);
}

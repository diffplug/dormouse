/**
 * The one ICE server Dormouse names (`docs/specs/remote-network.md` ->
 * "Anywhere"), shared by the Burrow host and the phone pages, so it imports
 * nothing. **Never TURN**, and never another STUN server:
 * `scripts/e2e-lint.mjs` holds this the only file that spells an ICE server URL.
 */

/** Cloudflare's STUN, which reports the public address a peer's socket is mapped to. */
export const CLOUDFLARE_STUN_URL = 'stun:stun.cloudflare.com:3478';

/** The host that URL names, as Settings → Network lists it. */
export const CLOUDFLARE_STUN_HOST = CLOUDFLARE_STUN_URL.split(':')[1]!;

/**
 * A peer's ICE servers: Cloudflare's STUN when `stun`, else none. Fresh objects
 * on every call, because the native polyfill rewrites a server's string `urls`
 * in place.
 */
export function stunServers(stun: boolean): Array<{ urls: string }> {
  return stun ? [{ urls: CLOUDFLARE_STUN_URL }] : [];
}

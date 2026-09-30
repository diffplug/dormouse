/**
 * The one relay origin this build was baked with, and the mode it sets
 * (`docs/specs/relay.md` → "Relay origin"): the Burrow's only Relay, and — in a
 * Hosted build — where the one-time rendezvous and managed voice go too.
 *
 * Baked by `scripts/relay-origin.mjs` into both host bundles. **Never webview
 * input** — no command carries an origin.
 */

import { normalizeOrigin } from 'remote-lib-common';

/**
 * The origin a stock build reaches: Hosted. Kept equal to
 * `scripts/relay-origin.mjs` by `relay-origin.test.ts` — the build scripts read
 * the `.mjs`, the service reads this, and a drift would ship a binary whose
 * mode disagrees with its origin.
 */
export const DEFAULT_RELAY_ORIGIN = 'https://hosted.dormouse.sh';

/**
 * `hosted`: the default origin, or a dev build's `DORMOUSE_RELAY_IS_HOSTED=1`.
 * `self-host`: any other origin, which is then this build's only Relay and
 * which reaches nothing of Dormouse's in the background.
 */
export type RelayMode = 'hosted' | 'self-host';

/** Substituted by esbuild at build time; see `scripts/relay-origin.mjs`. */
declare const __DORMOUSE_RELAY_ORIGIN__: string;
declare const __DORMOUSE_RELAY_MODE__: string;

/**
 * The origin this build was compiled with — with {@link bakedRelayMode}, the one
 * place the baked value is read.
 *
 * A `define` substitutes the identifier wherever it appears in the bundle,
 * imported lib modules included, so declaring it here rather than at each entry
 * point keeps the value a literal in the bundle with no second copy of the
 * fallback to drift. The `typeof` guard is for the test runners, which have no
 * define.
 */
export function bakedRelayOrigin(): string {
  return typeof __DORMOUSE_RELAY_ORIGIN__ === 'string'
    ? __DORMOUSE_RELAY_ORIGIN__
    : DEFAULT_RELAY_ORIGIN;
}

/** The mode this build was compiled with; see {@link bakedRelayOrigin}. */
export function bakedRelayMode(): RelayMode {
  if (typeof __DORMOUSE_RELAY_MODE__ !== 'string') return 'hosted';
  return __DORMOUSE_RELAY_MODE__ === 'self-host' ? 'self-host' : 'hosted';
}

/**
 * Whether a stored Relay URL names `relayOrigin`, compared as origins. An
 * enrollment for which this is false **reads as none** — it stays on disk, but
 * nothing connects to an origin the build was not baked with.
 */
export function isRelayOrigin(url: string, relayOrigin: string): boolean {
  const origin = normalizeOrigin(url);
  return origin !== null && origin === normalizeOrigin(relayOrigin);
}

/**
 * Where a Burrow opens a one-time connection's rendezvous, and whether this
 * build may (`docs/specs/one-time.md` -> "Service and hosts").
 *
 * Baked the way the Relay allowlist is (`connect-src.ts`): one build-time
 * variable, `DORMOUSE_ONE_TIME_ORIGIN`, substituted into both host bundles by
 * `scripts/csp-defaults.mjs`. **Never webview input** — no command carries an
 * origin — and fenced by that same allowlist, so a build reaches no rendezvous
 * its own connect-src would refuse.
 */

import {
  ONE_TIME_FRAGMENT_LENGTH,
  ONE_TIME_LINK_MAX_LENGTH,
  ONE_TIME_PAGE_PATH,
  isLinkScheme,
  isOrigin,
} from 'remote-lib-common';

import type { OneTimeUnavailableReason } from '../../remote/burrow/one-time-runtime';
import { originAllowedByConnectSrc } from './connect-src';

/**
 * The rendezvous baked into published builds. Kept equal to
 * `scripts/csp-defaults.mjs` by `one-time-origin.test.ts`, for the reason
 * `DEFAULT_REMOTE_CONNECT_SRC` is.
 */
export const DEFAULT_ONE_TIME_ORIGIN = 'https://hosted.dormouse.sh';

/**
 * The longest origin a link still fits: everything else in one is fixed —
 * the page path, the `#`, and the fragment. Checked here so a build baked with
 * an origin too long to scan is unavailable, rather than ending every link it
 * mints in `formatOneTimeLinkUrl`'s refusal. `scripts/csp-defaults.mjs` keeps
 * the same number.
 */
export const MAX_ONE_TIME_ORIGIN_LENGTH =
  ONE_TIME_LINK_MAX_LENGTH - ONE_TIME_PAGE_PATH.length - '#'.length - ONE_TIME_FRAGMENT_LENGTH;

/** Substituted by esbuild at build time; see `scripts/csp-defaults.mjs`. */
declare const __DORMOUSE_ONE_TIME_ORIGIN__: string;

/**
 * The rendezvous origin this build was compiled with — the one place the baked
 * value is read. Declared here rather than at each entry point for the reason
 * `bakedConnectSrc` gives; the `typeof` guard is for the test runners, which
 * have no define.
 */
export function bakedOneTimeOrigin(): string {
  return typeof __DORMOUSE_ONE_TIME_ORIGIN__ === 'string'
    ? __DORMOUSE_ONE_TIME_ORIGIN__
    : DEFAULT_ONE_TIME_ORIGIN;
}

/**
 * Why this build offers no one-time connection, or `null` when it does.
 *
 * - **`origin-invalid`**: not a bare origin (no path, credentials, or trailing
 *   slash, since the link is composed by appending to it), not HTTPS or HTTP on
 *   one of the link loopback hosts (`isLinkScheme`, the rule a phone parses
 *   the link under), or longer than {@link MAX_ONE_TIME_ORIGIN_LENGTH}.
 * - **`origin-not-allowed`**: outside `connectSrc`. One check answers for the
 *   page and the socket the runtime dials (`http` replaced by `ws`) alike: the
 *   matcher reads https and wss as one scheme, and http and ws as another.
 *
 * Decided before any socket exists: the service builds no runtime for an
 * origin this answers non-null for.
 */
export function oneTimeAvailability(
  origin: string,
  connectSrc: string,
): OneTimeUnavailableReason | null {
  if (!isOrigin(origin) || origin.length > MAX_ONE_TIME_ORIGIN_LENGTH) return 'origin-invalid';
  if (!isLinkScheme(new URL(origin))) return 'origin-invalid';
  return originAllowedByConnectSrc(origin, connectSrc) ? null : 'origin-not-allowed';
}

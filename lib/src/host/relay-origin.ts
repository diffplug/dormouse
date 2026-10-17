/**
 * The one relay origin this build was baked with, and the mode it sets
 * (`docs/specs/relay.md` → "Relay origin"): the Burrow's only Relay, and — in a
 * Hosted build — where the one-time rendezvous goes too. Managed voice speaks
 * at {@link HOSTED_VOICE_ORIGIN} instead, and enrollment is approved at
 * {@link HOSTED_ACCOUNT_ORIGIN}.
 *
 * Baked by `scripts/relay-origin.mjs` into both host bundles. **Never webview
 * input** — no command carries an origin.
 */

import { normalizeOrigin } from 'remote-lib-common';

/**
 * The relay origin a stock build reaches: Hosted's. Kept equal to
 * `scripts/relay-origin.mjs` by `relay-origin.test.ts` — the build scripts read
 * the `.mjs`, the service reads this, and a drift would ship a binary whose
 * mode disagrees with its origin.
 */
export const DEFAULT_RELAY_ORIGIN = 'https://relay.dormouse.sh';

/**
 * Where a Hosted build's managed voice speaks. A fixed constant, never baked
 * and never overridden: a dev Hosted build whose relay origin is loopback still
 * speaks here (`docs/specs/relay.md` → "Relay origin").
 */
export const HOSTED_VOICE_ORIGIN = 'https://voice.dormouse.sh';

/**
 * The Hosted account's origin, where a Hosted build's enrollment is approved
 * and its computers are managed. A fixed constant, never baked: **the desktop
 * never requests it**, and opens it only on the user's click
 * (`docs/specs/relay.md` → "Relay origin").
 */
export const HOSTED_ACCOUNT_ORIGIN = 'https://hosted.dormouse.sh';

/** The account page that lists its enrolled computers, with Remove. */
export const ACCOUNT_PAGE_PATH = '/account';

/**
 * `hosted`: the default origin, or a dev build's `DORMOUSE_RELAY_IS_HOSTED=1`.
 * `self-host`: any other origin, which is then this build's only Relay and
 * which reaches nothing of Dormouse's in the background.
 */
export type RelayMode = 'hosted' | 'self-host';

/** This build's baked relay origin and the mode it sets. */
export interface RelayBuild {
  origin: string;
  mode: RelayMode;
}

/** Substituted by esbuild at build time; see `scripts/relay-origin.mjs`. */
declare const __DORMOUSE_RELAY_ORIGIN__: string;
declare const __DORMOUSE_RELAY_MODE__: string;

/**
 * The pair this build was compiled with — with {@link bakedRelayMode}, the one
 * place the baked value is read. The hosts read it once, at their entry
 * points, and inject it.
 *
 * A `define` substitutes the identifier wherever it appears in the bundle,
 * imported lib modules included, so declaring it here rather than at each entry
 * point keeps the value a literal in the bundle with no second copy of the
 * fallback to drift. The `typeof` guards are for the test runners, which have
 * no define; a build that lost it fails (`assertRelayOriginBaked`, and
 * `relayDefineVitePlugin` for the standalone webview).
 */
export function bakedRelay(): RelayBuild {
  const origin = typeof __DORMOUSE_RELAY_ORIGIN__ === 'string'
    ? __DORMOUSE_RELAY_ORIGIN__
    : DEFAULT_RELAY_ORIGIN;
  return { origin, mode: bakedRelayMode() };
}

/**
 * The mode this build was compiled with; see {@link bakedRelay}. The webview
 * reads it on its own, the standalone Vite build baking the same pair.
 *
 * Fails closed: anything but a baked `hosted` — no define, or an unknown value —
 * reads as `self-host`, which reaches nothing of Dormouse's in the background.
 */
export function bakedRelayMode(): RelayMode {
  return typeof __DORMOUSE_RELAY_MODE__ === 'string' && __DORMOUSE_RELAY_MODE__ === 'hosted' ? 'hosted' : 'self-host';
}

/**
 * Where this build may reach Hosted's one-time rendezvous: the relay origin in
 * a Hosted build, and `null` in a self-host one, which reaches nothing of
 * Dormouse's in the background. Every Hosted-reaching feature takes this or
 * {@link hostedVoiceOrigin} and does nothing on `null`.
 */
export function hostedOrigin(relay: RelayBuild): string | null {
  return relay.mode === 'hosted' ? relay.origin : null;
}

/**
 * Where this build's managed voice may speak: {@link HOSTED_VOICE_ORIGIN} in a
 * Hosted build, whatever its relay origin, and `null` in a self-host one.
 */
export function hostedVoiceOrigin(relay: RelayBuild): string | null {
  return relay.mode === 'hosted' ? HOSTED_VOICE_ORIGIN : null;
}

/**
 * Where this build's enrollment is approved: {@link HOSTED_ACCOUNT_ORIGIN} in
 * a Hosted build, and `null` in a self-host one, which enrolls with its own
 * Relay's setup password.
 */
export function hostedAccountOrigin(relay: RelayBuild): string | null {
  return relay.mode === 'hosted' ? HOSTED_ACCOUNT_ORIGIN : null;
}

/**
 * Whether this is a dev Hosted build: Hosted mode at an origin other than the
 * default, which only `DORMOUSE_RELAY_IS_HOSTED` in a dev build can bake
 * (`scripts/relay-origin.mjs`). Its Relay is a local or preview Worker whose
 * account page is not {@link HOSTED_ACCOUNT_ORIGIN}.
 */
export function isDevHostedBuild(relay: RelayBuild): boolean {
  return relay.mode === 'hosted' && !isRelayOrigin(relay.origin, DEFAULT_RELAY_ORIGIN);
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

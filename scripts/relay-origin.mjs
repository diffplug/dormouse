// The one relay origin a desktop build bakes, and the mode it sets
// (docs/specs/relay.md → "Relay origin"). Both host builds read it here —
// `standalone/scripts/build-sidecar-proxy.mjs` and `vscode-ext/scripts/esbuild.mjs`
// — and esbuild-`define` the result into the Node bundle that holds the relay
// socket, where `lib/src/host/relay-origin.ts` is the only reader.
//
// The accepted-origin rule is the built `remote-lib-common`'s, so every caller
// builds that package first. The default is duplicated from the `.ts`, which a
// build script cannot import; `lib/src/host/relay-origin.test.ts` pins it.

import { readFileSync } from 'node:fs';
import {
  LINK_LOOPBACK_HOSTS,
  MAX_RELAY_ORIGIN_LENGTH,
  isAcceptedRelayOrigin,
} from '../remote-lib-common/dist/index.js';

/** The identifiers esbuild substitutes; read by `lib/src/host/relay-origin.ts`. */
export const RELAY_ORIGIN_PLACEHOLDER = '__DORMOUSE_RELAY_ORIGIN__';
export const RELAY_MODE_PLACEHOLDER = '__DORMOUSE_RELAY_MODE__';

/** The relay origin a stock build reaches: Hosted's. */
export const DEFAULT_RELAY_ORIGIN = 'https://relay.dormouse.sh';

/**
 * Variables that once chose an origin `DORMOUSE_RELAY_ORIGIN` now chooses.
 * Ignoring one would build a stock Hosted binary for someone following older
 * instructions, with nothing to say so.
 */
export const RETIRED_RELAY_VARIABLES = ['DORMOUSE_REMOTE_CONNECT_SRC'];

function blank(value) {
  return value === undefined || value.trim() === '';
}

/**
 * The origin and mode this build bakes, from `DORMOUSE_RELAY_ORIGIN` and, in a
 * dev build only, `DORMOUSE_RELAY_IS_HOSTED`. Fails the build, naming the
 * variable, on:
 *
 * - a retired variable set to anything non-blank;
 * - an origin outside {@link isAcceptedRelayOrigin};
 * - in any build but a dev build, `DORMOUSE_RELAY_IS_HOSTED` set at all, or a
 *   loopback `http:` origin (docs/specs/relay.md → "Relay origin").
 *
 * `dev` marks a dev build (docs/specs/relay.md → "Relay origin"); every other
 * build is a release build. Logs to stderr whenever the result is not the
 * stock one.
 */
export function resolveRelayOrigin(env = process.env, label = 'build', { dev = false } = {}) {
  for (const name of RETIRED_RELAY_VARIABLES) {
    if (!blank(env[name])) {
      throw new Error(
        `[${label}] ${name} is retired: a build bakes exactly one relay origin, ` +
          'DORMOUSE_RELAY_ORIGIN (docs/specs/relay.md → "Relay origin"). Unset it.',
      );
    }
  }

  const override = env.DORMOUSE_RELAY_ORIGIN?.trim();
  const origin = override || DEFAULT_RELAY_ORIGIN;
  if (!isAcceptedRelayOrigin(origin)) {
    throw new Error(
      `[${label}] DORMOUSE_RELAY_ORIGIN: "${origin}" is not an origin a build can bake. It must ` +
        `be a bare https:// origin, or http:// on ${[...LINK_LOOPBACK_HOSTS].join(', ')} in a dev ` +
        `build, with no path or trailing slash, at most ${MAX_RELAY_ORIGIN_LENGTH} characters ` +
        `(e.g. "${DEFAULT_RELAY_ORIGIN}").`,
    );
  }

  const flag = env.DORMOUSE_RELAY_IS_HOSTED?.trim();
  if (!dev) {
    if (flag) {
      throw new Error(
        `[${label}] DORMOUSE_RELAY_IS_HOSTED is for dev builds only (pnpm dev:standalone, ` +
          'pnpm innerdogfood, VS Code watch); a release build is Hosted only at ' +
          `${DEFAULT_RELAY_ORIGIN}.`,
      );
    }
    if (new URL(origin).protocol === 'http:') {
      throw new Error(
        `[${label}] DORMOUSE_RELAY_ORIGIN: "${origin}" is a loopback http:// origin, which only a ` +
          'dev build (pnpm dev:standalone, pnpm innerdogfood, VS Code watch) may bake.',
      );
    }
  } else if (flag && flag !== '1') {
    throw new Error(`[${label}] DORMOUSE_RELAY_IS_HOSTED must be 1 or unset, not "${flag}".`);
  }

  const mode = origin === DEFAULT_RELAY_ORIGIN || flag === '1' ? 'hosted' : 'self-host';
  if (origin !== DEFAULT_RELAY_ORIGIN) {
    console.error(`[${label}] relay origin ${origin} (${mode} build)`);
  }
  return { origin, mode };
}

/** The esbuild `define` entries for a {@link resolveRelayOrigin} result. */
export function relayOriginDefine({ origin, mode }) {
  return {
    [RELAY_ORIGIN_PLACEHOLDER]: JSON.stringify(origin),
    [RELAY_MODE_PLACEHOLDER]: JSON.stringify(mode),
  };
}

/**
 * Fail the build if the `define` did not reach `bundlePath`.
 *
 * The readers use the placeholders as `declare const`s, so a lost define
 * compiles fine and shows up only at runtime — as a Burrow that silently uses
 * the default, Hosted, instead of the self-hoster's Relay. Both bundles bake
 * the same pair, so both fail on the same class of drift: someone re-inlines
 * the esbuild call, or adds an entry point that pulls in the Burrow without it.
 */
export function assertRelayOriginBaked(bundlePath, { origin }) {
  const bundle = readFileSync(bundlePath, 'utf8');
  for (const placeholder of [RELAY_ORIGIN_PLACEHOLDER, RELAY_MODE_PLACEHOLDER]) {
    if (bundle.includes(placeholder)) {
      throw new Error(
        `relay origin: ${placeholder} survived into ${bundlePath} — the esbuild define did not ` +
          'apply, and the Burrow would use the built-in default.',
      );
    }
  }
  if (!bundle.includes(origin)) {
    throw new Error(`relay origin: ${bundlePath} does not contain the resolved origin (${origin}).`);
  }
}

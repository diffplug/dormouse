// The one definition of where a Burrow may reach a Relay, shared by both
// Burrows' build scripts.
//
// Both Burrows now run outside any webview — standalone's in the sidecar, VS
// Code's in the extension host — so neither is fenced by a CSP and both bake
// this list into their bundle instead (`standalone/scripts/build-sidecar-proxy.mjs`,
// `vscode-ext/scripts/esbuild.mjs`), where the service refuses any origin
// outside it. The *fact* is one fact — duplicating it meant a change to the
// SaaS origin could ship one Burrow pointed at the old one. See
// docs/specs/relay.md → "Where a Burrow may reach a Relay".

import { readFileSync } from 'node:fs';

/** The identifier esbuild substitutes; read by `lib/src/host/remote/connect-src.ts`. */
export const CONNECT_SRC_PLACEHOLDER = '__DORMOUSE_REMOTE_CONNECT_SRC__';

/** The remote-server `connect-src` sources baked into the published builds. */
export const DEFAULT_REMOTE_CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';

/**
 * The grammar one source must have, duplicated from
 * `lib/src/host/remote/connect-src.ts` — a build script cannot import
 * TypeScript, and `lib/src/host/remote/connect-src.test.ts` asserts the two
 * patterns are the same string.
 */
export const CONNECT_SRC_SOURCE_PATTERN = /^((?:https?|wss?):)\/\/([^/:]+)(?::(\*|\d+))?$/i;

function isSupportedSource(source) {
  const match = CONNECT_SRC_SOURCE_PATTERN.exec(source);
  if (!match) return false;
  const rawPort = match[3];
  if (rawPort === undefined || rawPort === '*') return true;
  const port = Number(rawPort);
  return Number.isInteger(port) && port >= 1 && port <= 65_535;
}

/**
 * The sources this build should use: the selfhoster's `DORMOUSE_REMOTE_CONNECT_SRC`
 * if set and non-empty, otherwise the shipped default. Logs to stderr when it
 * overrides, so a custom build says so in its output.
 *
 * An override the runtime matcher cannot parse fails the build. Silently it
 * matches nothing — `originAllowedByConnectSrc` fails closed on a source it
 * cannot read — so a trailing slash or a missing scheme produces a binary that
 * builds green and then refuses to enroll against the very server it was built
 * for, with an error naming the list it was already given.
 */
export function resolveRemoteConnectSrc(env = process.env, label = 'build') {
  const override = env.DORMOUSE_REMOTE_CONNECT_SRC?.trim();
  if (!override) return DEFAULT_REMOTE_CONNECT_SRC;
  for (const source of override.split(/\s+/)) {
    if (!source || isSupportedSource(source)) continue;
    throw new Error(
      `[${label}] DORMOUSE_REMOTE_CONNECT_SRC: "${source}" is not a source the Burrow can ` +
        'match. Each entry must use http, https, ws, or wss with a host and an optional ' +
        ':port (1–65535) or :* — no trailing slash or path ' +
        `(e.g. "${DEFAULT_REMOTE_CONNECT_SRC}").`,
    );
  }
  console.error(`[${label}] connect-src remote sources overridden: ${override}`);
  return override;
}

/**
 * Fail the build if the `define` did not reach `bundlePath`.
 *
 * The source reads the placeholder as a `declare const`, so a lost define
 * compiles fine and only shows up at runtime — as a Burrow that silently uses the
 * shipped default allowlist instead of the selfhoster's origins. Both bundles
 * bake the same variable, so both fail on the same class of drift: someone
 * re-inlines the esbuild call, or adds an entry point that pulls in the Burrow
 * without the define.
 */
export function assertConnectSrcBaked(bundlePath, remoteSrc) {
  const bundle = readFileSync(bundlePath, 'utf8');
  if (bundle.includes(CONNECT_SRC_PLACEHOLDER)) {
    throw new Error(
      `connect-src: ${CONNECT_SRC_PLACEHOLDER} survived into ${bundlePath} — the esbuild define ` +
        'did not apply, and the Burrow would use the built-in default sources.',
    );
  }
  if (!bundle.includes(remoteSrc)) {
    throw new Error(
      `connect-src: ${bundlePath} does not contain the resolved sources (${remoteSrc}).`,
    );
  }
}

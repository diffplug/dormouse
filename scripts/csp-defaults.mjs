// The one definition of where a Burrow may reach a Relay, shared by both
// Burrows' build scripts — and, at the end, of the one-time rendezvous.
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
 * cannot read — so a trailing slash, a path, a bare host, a scheme outside
 * http/https/ws/wss, or a port outside 1–65535 produces a binary that builds
 * green and then refuses to enroll against the very server it was built for,
 * with an error naming the list it was already given.
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

// --- The one-time rendezvous ---
//
// Where a Burrow opens a one-time connection's handshake
// (docs/specs/one-time.md). Baked by the same two builds, beside the allowlist
// above, and fenced by it at runtime: `oneTimeAvailability` in
// `lib/src/host/remote/one-time-origin.ts` refuses an origin connect-src does
// not admit, so an override here needs a matching `DORMOUSE_REMOTE_CONNECT_SRC`.

/** The identifier esbuild substitutes; read by `lib/src/host/remote/one-time-origin.ts`. */
export const ONE_TIME_ORIGIN_PLACEHOLDER = '__DORMOUSE_ONE_TIME_ORIGIN__';

/** The rendezvous baked into published builds; `one-time-origin.test.ts` pins it to the `.ts`. */
export const DEFAULT_ONE_TIME_ORIGIN = 'https://hosted.dormouse.sh';

/**
 * The longest origin a one-time link fits, duplicated from
 * `MAX_ONE_TIME_ORIGIN_LENGTH` in `lib/src/host/remote/one-time-origin.ts`
 * (pinned equal there): 256, less `/connect/`, the `#`, and the 79-character
 * fragment.
 */
export const MAX_ONE_TIME_ORIGIN_LENGTH = 167;

/**
 * The hosts plain HTTP is allowed on, duplicated from `LINK_LOOPBACK_HOSTS` in
 * `remote-lib-common/src/security/link-url.ts` (pinned equal by
 * `one-time-origin.test.ts`): a phone parses the link under that rule, so an
 * origin outside it mints links no phone will open.
 */
export const ONE_TIME_LOOPBACK_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

/**
 * Whether `origin` is one the runtime can use: a bare origin — `new URL`'s own
 * spelling of it, so no path, trailing slash, query, fragment, or credentials —
 * on HTTPS, or on HTTP at a loopback host, and short enough to fit a link.
 * `oneTimeAvailability`'s `origin-invalid` half, which the test pins this to.
 */
function isUsableOneTimeOrigin(origin) {
  if (typeof origin !== 'string' || origin.length > MAX_ONE_TIME_ORIGIN_LENGTH) return false;
  let url;
  try {
    url = new URL(origin);
  } catch {
    return false;
  }
  if (url.origin !== origin) return false;
  return (
    url.protocol === 'https:' ||
    (url.protocol === 'http:' && ONE_TIME_LOOPBACK_HOSTS.includes(url.hostname))
  );
}

/**
 * The rendezvous origin this build should bake: `DORMOUSE_ONE_TIME_ORIGIN` if
 * set and non-empty, otherwise the shipped default. Logs to stderr when it
 * overrides. An override the runtime could never use fails the build, for the
 * reason a malformed `DORMOUSE_REMOTE_CONNECT_SRC` does: silently, it builds a
 * binary whose One-time connection button is disabled for a reason nobody asked
 * for.
 */
export function resolveOneTimeOrigin(env = process.env, label = 'build') {
  const override = env.DORMOUSE_ONE_TIME_ORIGIN?.trim();
  if (!override) return DEFAULT_ONE_TIME_ORIGIN;
  if (!isUsableOneTimeOrigin(override)) {
    throw new Error(
      `[${label}] DORMOUSE_ONE_TIME_ORIGIN: "${override}" is not an origin a one-time link can ` +
        `carry. It must be a bare https:// origin, or http:// on ${ONE_TIME_LOOPBACK_HOSTS.join(', ')}, ` +
        `with no path or trailing slash, at most ${MAX_ONE_TIME_ORIGIN_LENGTH} characters ` +
        `(e.g. "${DEFAULT_ONE_TIME_ORIGIN}").`,
    );
  }
  console.error(`[${label}] one-time rendezvous origin overridden: ${override}`);
  return override;
}

/**
 * Fail the build if the one-time define did not reach `bundlePath` — the same
 * class of drift `assertConnectSrcBaked` catches, with the same symptom
 * otherwise: a lost define compiles, and the Burrow silently opens the shipped
 * default's rendezvous instead of the one it was built for.
 */
export function assertOneTimeOriginBaked(bundlePath, origin) {
  const bundle = readFileSync(bundlePath, 'utf8');
  if (bundle.includes(ONE_TIME_ORIGIN_PLACEHOLDER)) {
    throw new Error(
      `one-time origin: ${ONE_TIME_ORIGIN_PLACEHOLDER} survived into ${bundlePath} — the esbuild ` +
        'define did not apply, and the Burrow would use the built-in default rendezvous.',
    );
  }
  if (!bundle.includes(origin)) {
    throw new Error(`one-time origin: ${bundlePath} does not contain the resolved origin (${origin}).`);
  }
}

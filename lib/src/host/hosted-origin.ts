/**
 * The Hosted origin this build talks to: where a Burrow opens a one-time
 * connection's rendezvous (`docs/specs/one-time.md` -> "Service and hosts") and
 * where standalone's sidecar sends managed voice
 * (`docs/specs/security-local.md` -> "Persisted state").
 *
 * Baked the way the Relay allowlist is (`remote/connect-src.ts`): one build-time
 * variable, `DORMOUSE_HOSTED_ORIGIN`, substituted into both host bundles by
 * `scripts/csp-defaults.mjs`. **Never webview input** — no command carries an
 * origin.
 */

/**
 * The Hosted origin baked into published builds. Kept equal to
 * `scripts/csp-defaults.mjs` by `remote/one-time-origin.test.ts`, for the reason
 * `DEFAULT_REMOTE_CONNECT_SRC` is.
 */
export const DEFAULT_HOSTED_ORIGIN = 'https://hosted.dormouse.sh';

/** Substituted by esbuild at build time; see `scripts/csp-defaults.mjs`. */
declare const __DORMOUSE_HOSTED_ORIGIN__: string;

/**
 * The Hosted origin this build was compiled with — the one place the baked
 * value is read. Declared here rather than at each entry point for the reason
 * `bakedConnectSrc` gives; the `typeof` guard is for the test runners, which
 * have no define.
 */
export function bakedHostedOrigin(): string {
  return typeof __DORMOUSE_HOSTED_ORIGIN__ === 'string'
    ? __DORMOUSE_HOSTED_ORIGIN__
    : DEFAULT_HOSTED_ORIGIN;
}

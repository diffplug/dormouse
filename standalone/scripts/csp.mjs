// Build-time CSP `connect-src` policy for the standalone binary.
//
// The shipped binary everyone downloads is scoped to the SaaS origin only:
// remote-control Hosts talk to `*.dormouse.sh` over https/wss, and nothing
// else. That covers the ~99% of users (no remote at all, or SaaS) with the
// tightest connect-src, so a compromised webview can't exfiltrate to an
// arbitrary host. Self-hosters (who reach a server on their own domain or a
// tailnet) widen it for their own custom build via DORMOUSE_REMOTE_CONNECT_SRC
// — see docs/specs/server.md. The default lives in src-tauri/tauri.conf.json;
// this module is the single place that knows how to retarget it.

/** The remote-server `connect-src` sources baked into the shipped binary. */
export const DEFAULT_REMOTE_CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';

/**
 * Return `baseCsp` with its default remote-server sources replaced by
 * `remoteSrc` (a space-separated CSP source list, e.g.
 * `https://dormouse.example.com wss://dormouse.example.com`). Throws if the
 * default sources aren't present, so a drifted base CSP fails the build loudly
 * instead of silently shipping an unintended policy.
 */
export function withRemoteConnectSrc(baseCsp, remoteSrc) {
  if (!baseCsp.includes(DEFAULT_REMOTE_CONNECT_SRC)) {
    throw new Error(
      `CSP override: expected default remote sources ${JSON.stringify(DEFAULT_REMOTE_CONNECT_SRC)} ` +
        'in the base CSP, but they were not found. tauri.conf.json changed — ' +
        'update DEFAULT_REMOTE_CONNECT_SRC in standalone/scripts/csp.mjs to match.',
    );
  }
  return baseCsp.replaceAll(DEFAULT_REMOTE_CONNECT_SRC, remoteSrc.trim());
}

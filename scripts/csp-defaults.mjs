// The one definition of where a Host may reach a relay server, shared by both
// Hosts' build scripts.
//
// The standalone binary and the VS Code extension bake this into their webview
// CSP by different mechanisms — Tauri has a config file to override
// (`standalone/scripts/csp.mjs` + `tauri.mjs`), the extension has no runtime
// config so esbuild substitutes a bundle literal
// (`vscode-ext/scripts/esbuild.mjs`) — but the *fact* is one fact. Duplicating
// it meant a change to the SaaS origin could ship one Host pointed at the old
// one. See docs/specs/server.md → "Host webview CSP".

/** The remote-server `connect-src` sources baked into the published builds. */
export const DEFAULT_REMOTE_CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';

/**
 * The sources this build should use: the selfhoster's `DORMOUSE_REMOTE_CONNECT_SRC`
 * if set and non-empty, otherwise the shipped default. Logs to stderr when it
 * overrides, so a custom build says so in its output.
 */
export function resolveRemoteConnectSrc(env = process.env, label = 'build') {
  const override = env.DORMOUSE_REMOTE_CONNECT_SRC?.trim();
  if (!override) return DEFAULT_REMOTE_CONNECT_SRC;
  console.error(`[${label}] connect-src remote sources overridden: ${override}`);
  return override;
}

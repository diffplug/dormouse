// The one definition of where a Host may reach a relay server, shared by both
// Hosts' build scripts.
//
// The two Hosts bake it in at different places, because their Hosts run in
// different processes: standalone's runs in the sidecar, so esbuild substitutes
// it into that bundle (`standalone/scripts/build-sidecar-proxy.mjs`) and the
// service refuses any origin outside it; the VS Code extension still hosts the
// Host in its webview, so esbuild substitutes it into the webview's CSP
// (`vscode-ext/scripts/esbuild.mjs`) until that Host migrates too. Either way
// the *fact* is one fact — duplicating it meant a change to the SaaS origin
// could ship one Host pointed at the old one. See docs/specs/server.md →
// "Host webview CSP".

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

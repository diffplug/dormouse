// Bundles the extension host and the PTY host, and is the single place that
// bakes the webview's remote-server `connect-src` into the build.
//
// The published extension is scoped to the SaaS origin only, so a compromised
// webview cannot exfiltrate to an arbitrary host. A selfhoster whose relay is
// on their own domain or tailnet widens it for their own build:
//
//   DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
//
// This mirrors the standalone binary's build-time override
// (`standalone/scripts/tauri.mjs` + `csp.mjs`) so both Hosts widen the same way
// with the same variable. See docs/specs/server.md → "Host webview CSP".

import * as esbuild from 'esbuild';

/** The remote-server sources baked into the published extension. */
export const DEFAULT_REMOTE_CONNECT_SRC = 'https://*.dormouse.sh wss://*.dormouse.sh';

const remoteSrc = process.env.DORMOUSE_REMOTE_CONNECT_SRC?.trim() || DEFAULT_REMOTE_CONNECT_SRC;
if (remoteSrc !== DEFAULT_REMOTE_CONNECT_SRC) {
  console.error(`[esbuild] webview connect-src remote sources overridden: ${remoteSrc}`);
}

const watch = process.argv.includes('--watch');

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  external: ['vscode', 'node-pty'],
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outdir: 'dist',
    define: { __DORMOUSE_REMOTE_CONNECT_SRC__: JSON.stringify(remoteSrc) },
  },
  {
    ...common,
    entryPoints: ['src/pty-host.js'],
    outfile: 'dist/pty-host.js',
    external: ['node-pty'],
  },
];

if (watch) {
  for (const options of builds) {
    const ctx = await esbuild.context(options);
    await ctx.watch();
  }
  console.error('[esbuild] watching');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
}

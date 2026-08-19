// Bundles the extension host and the PTY host, and is the single place that
// bakes the remote Host's allowed relay origins into the build.
//
// The published extension is scoped to the SaaS origin only, so the Host will
// not enroll with, or connect to, an arbitrary server. A selfhoster whose relay
// is on their own domain or tailnet widens it for their own build:
//
//   DORMOUSE_REMOTE_CONNECT_SRC='https://*.ts.net wss://*.ts.net' pnpm dogfood:vscode
//
// This mirrors the standalone binary's build-time override
// (`standalone/scripts/tauri.mjs` + `csp.mjs`) so both Hosts widen the same way
// with the same variable. See docs/specs/server.md → "Host webview CSP".

import * as esbuild from 'esbuild';

import {
  assertConnectSrcBaked,
  CONNECT_SRC_PLACEHOLDER,
  resolveRemoteConnectSrc,
} from '../../scripts/csp-defaults.mjs';

const remoteSrc = resolveRemoteConnectSrc(process.env, 'esbuild');

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
    define: { [CONNECT_SRC_PLACEHOLDER]: JSON.stringify(remoteSrc) },
  },
  {
    ...common,
    entryPoints: ['src/pty-host.js'],
    outfile: 'dist/pty-host.js',
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
  assertConnectSrcBaked('dist/extension.js', remoteSrc);
}

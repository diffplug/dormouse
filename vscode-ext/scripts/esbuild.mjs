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

import { readFileSync } from 'node:fs';

import * as esbuild from 'esbuild';

import { resolveRemoteConnectSrc } from '../../scripts/csp-defaults.mjs';

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
    define: { __DORMOUSE_REMOTE_CONNECT_SRC__: JSON.stringify(remoteSrc) },
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
  assertConnectSrcBaked();
}

/**
 * Fail the build if the `define` did not reach the bundle.
 *
 * `remote-host.ts` reads `__DORMOUSE_REMOTE_CONNECT_SRC__` as a `declare const`,
 * so if the substitution is ever lost — someone re-inlines the esbuild call, or
 * adds a bundle entry that pulls in that module without the define — TypeScript
 * still compiles and the failure only appears at runtime, where the Host would
 * silently fall back to the built-in default instead of the selfhoster's
 * origins. The standalone sidecar bakes the same variable, so this side should
 * fail on the same class of drift.
 */
function assertConnectSrcBaked() {
  const bundle = readFileSync('dist/extension.js', 'utf8');
  if (bundle.includes('__DORMOUSE_REMOTE_CONNECT_SRC__')) {
    throw new Error(
      'CSP: __DORMOUSE_REMOTE_CONNECT_SRC__ survived into dist/extension.js — the esbuild ' +
        'define did not apply, and the remote Host would use the built-in default sources.',
    );
  }
  if (!bundle.includes(remoteSrc)) {
    throw new Error(
      `CSP: dist/extension.js does not contain the resolved connect-src sources (${remoteSrc}).`,
    );
  }
}

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
// (`standalone/scripts/build-sidecar-proxy.mjs`, which bakes the same value into
// the sidecar's Host) so both Hosts widen the same way with the same variable.
// `scripts/csp-defaults.mjs` is the one definition of the default for both. See
// docs/specs/server.md → "Where a Host may reach a relay server".

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
  // `bufferutil` / `utf-8-validate` are `ws`'s optional native accelerators.
  // They are not installed and must not be — a `.node` addon cannot be bundled
  // and would have to be shipped per platform — so they stay as runtime
  // `require`s that `ws` already catches and falls back from.
  external: ['vscode', 'node-pty', 'bufferutil', 'utf-8-validate'],
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
    // Build once and assert before watching. The assertion exists because a
    // lost `define` compiles green, and a watch loop (`pnpm dogfood:vscode`)
    // is exactly where one plausibly goes missing — skipping it here left the
    // check absent from the build people actually iterate in.
    await ctx.rebuild();
    await ctx.watch();
  }
  assertConnectSrcBaked('dist/extension.js', remoteSrc);
  console.error('[esbuild] watching');
} else {
  await Promise.all(builds.map((options) => esbuild.build(options)));
  assertConnectSrcBaked('dist/extension.js', remoteSrc);
}

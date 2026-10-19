// Bundles the extension host and the PTY host, and bakes the Burrow's one relay
// origin into the extension host as `standalone/scripts/build-sidecar-proxy.mjs`
// does into the sidecar (docs/specs/relay.md → "Relay origin").

import * as esbuild from 'esbuild';

import { assertNothingInlined } from '../../scripts/assert-not-inlined.mjs';
import { workspaceSourceAliases } from '../../scripts/workspace-sources.mjs';
import {
  assertRelayOriginBaked,
  relayOriginDefine,
  resolveRelayOrigin,
} from '../../scripts/relay-origin.mjs';

const watch = process.argv.includes('--watch');
// `--watch` is VS Code's dev build (docs/specs/relay.md → "Relay origin").
const relay = resolveRelayOrigin(process.env, 'esbuild', { dev: watch });

// Staged into `dist/node_modules` by `stage-native-direct.mjs`, so it must stay
// a runtime `require` (`requireNative` in `native-direct-peer.ts`).
const NATIVE_DIRECT = ['node-datachannel'];
const assertBuilt = ({ metafile }) => {
  assertRelayOriginBaked('dist/extension.js', relay);
  assertNothingInlined(metafile, NATIVE_DIRECT, 'esbuild dist/extension.js');
};

const common = {
  bundle: true,
  format: 'cjs',
  platform: 'node',
  // `bufferutil` / `utf-8-validate` are `ws`'s optional native accelerators.
  // They are not installed and must not be — a `.node` addon cannot be bundled
  // and would have to be shipped per platform — so they stay as runtime
  // `require`s that `ws` already catches and falls back from.
  external: ['vscode', 'node-pty', 'bufferutil', 'utf-8-validate', ...NATIVE_DIRECT.flatMap((name) => [name, `${name}/*`])],
  alias: workspaceSourceAliases(),
};

const builds = [
  {
    ...common,
    entryPoints: ['src/extension.ts'],
    outdir: 'dist',
    define: relayOriginDefine(relay),
    metafile: true,
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
    const result = await ctx.rebuild();
    // Only the extension build asks for a metafile.
    if (options.metafile) assertBuilt(result);
    await ctx.watch();
  }
  console.error('[esbuild] watching');
} else {
  const [extension] = await Promise.all(builds.map((options) => esbuild.build(options)));
  assertBuilt(extension);
}

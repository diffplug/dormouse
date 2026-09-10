// Bundle the host-agnostic host modules (shared with the VS Code extension host)
// into CommonJS files the Node sidecar can require. Keeps each as a single
// TypeScript source while the sidecar itself stays plain CJS.
//   - lib/src/host/iframe-proxy.ts        → sidecar/iframe-proxy.cjs
//   - lib/src/host/agent-browser-host.ts  → sidecar/agent-browser-host.cjs
//   - lib/src/host/remote/sidecar-entry.ts → sidecar/burrow.cjs
// See docs/specs/dor-browser.md and docs/specs/remote-api.md.
import { build } from 'esbuild';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  assertConnectSrcBaked,
  CONNECT_SRC_PLACEHOLDER,
  resolveRemoteConnectSrc,
} from '../../scripts/csp-defaults.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const libHost = path.resolve(here, '../../lib/src/host');
const sidecar = path.resolve(here, '../sidecar');

// Where the Burrow may reach a Relay. The Burrow runs in the sidecar,
// so this is the enforcement point — there is no webview CSP in front of it.
const remoteSrc = resolveRemoteConnectSrc(process.env, 'sidecar');

// The Burrow's direct-path peer. `node-datachannel` resolves its platform
// package and `detect-libc` relative to its own `__dirname`, so it has to stay
// an installed package under `sidecar/node_modules` and be required by name —
// inlining it here would leave that loader looking beside `burrow.cjs`.
const NATIVE_DIRECT = ['node-datachannel', 'node-datachannel/polyfill'];

const bundles = [
  { entry: 'iframe-proxy.ts', out: 'iframe-proxy.cjs' },
  { entry: 'agent-browser-host.ts', out: 'agent-browser-host.cjs' },
  {
    entry: 'remote/sidecar-entry.ts',
    out: 'burrow.cjs',
    define: { [CONNECT_SRC_PLACEHOLDER]: JSON.stringify(remoteSrc) },
    assertBaked: true,
    external: NATIVE_DIRECT,
  },
];

/**
 * Fail the build if esbuild bundled a module the `external` list has to keep out.
 *
 * `native-direct-peer.ts` calls `require('<specifier>')` by literal, so an
 * external specifier stays a `require-call` edge out of the bundle and a bundled
 * one becomes an inlined module with no edge at all. That difference is the
 * whole check: a lost `external` entry produces a `burrow.cjs` that loads and
 * then cannot find the addon's `.node` file, which nothing before the first
 * `direct-offer` on a real machine would notice.
 */
function assertExternalImports(metafile, outfile, specifiers) {
  // esbuild keys `metafile.outputs` by path relative to the process cwd, with
  // `/` separators on every platform.
  const outputKey = path.relative(process.cwd(), outfile).split(path.sep).join('/');
  const imports = metafile.outputs[outputKey]?.imports;
  if (!imports) {
    throw new Error(
      `sidecar: esbuild metafile has no output for "${outputKey}" — cannot check external imports.`,
    );
  }
  for (const specifier of specifiers) {
    const kept = imports.some(
      (edge) => edge.path === specifier && edge.kind === 'require-call' && edge.external === true,
    );
    if (kept) continue;
    throw new Error(
      `sidecar: ${outputKey} has no external require("${specifier}") — esbuild bundled it, and ` +
        'the addon would look for its platform package beside the bundle instead of inside ' +
        'sidecar/node_modules.',
    );
  }
}

// `tauri.conf.json`'s `bundle.resources` globs this whole directory, so a
// pre-rename `remote-host.cjs` left in an older checkout would ship inside the
// app — a dead Burrow with its own baked connect-src allowlist.
await rm(path.resolve(sidecar, 'remote-host.cjs'), { force: true });

for (const { entry, out, define, assertBaked, external } of bundles) {
  const outfile = path.resolve(sidecar, out);
  const result = await build({
    entryPoints: [path.resolve(libHost, entry)],
    outfile,
    bundle: true,
    platform: 'node', // node builtins (http/net/fs/child_process) stay external
    format: 'cjs',
    target: 'node24',
    logLevel: 'warning',
    metafile: true,
    ...(define ? { define } : {}),
    ...(external ? { external } : {}),
  });
  if (assertBaked) assertConnectSrcBaked(outfile, remoteSrc);
  if (external) assertExternalImports(result.metafile, outfile, external);
  console.log(`[sidecar] built ${path.relative(process.cwd(), outfile)}`);
}

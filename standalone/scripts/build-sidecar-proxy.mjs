// Bundle the host-agnostic host modules (shared with the VS Code extension host)
// into CommonJS files the Node sidecar can require. Keeps each as a single
// TypeScript source while the sidecar itself stays plain CJS.
//   - lib/src/host/iframe-proxy.ts        → sidecar/iframe-proxy.cjs
//   - lib/src/host/browser-host.ts        → sidecar/browser-host.cjs
//   - lib/src/host/agent-browser-host.ts  → sidecar/agent-browser-host.cjs
//   - lib/src/host/playwright-host.ts     → sidecar/playwright-host.cjs
//   - lib/src/host/tool-host.ts           → sidecar/tool-host.cjs
//   - lib/src/host/git-info.ts            → sidecar/git-info.cjs
//   - lib/src/host/remote/sidecar-entry.ts → sidecar/burrow.cjs (the alerts too)
//   - lib/src/host/recovery.ts             → sidecar/recovery.cjs
// See docs/specs/dor-browser.md, docs/specs/remote-api.md,
// docs/specs/standalone.md -> "Agent recovery", and docs/specs/alert.md.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
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

// What the sidecar installs at runtime, read from the manifest that installs
// it: `node-datachannel` resolves its platform package and `detect-libc`
// relative to its own `__dirname`, so every one of these has to stay an
// installed package under `sidecar/node_modules` and be required by name —
// inlining one here would leave that loader looking beside `burrow.cjs`.
// Derived rather than listed, so declaring a dependency is what keeps it out.
//
// Both keys: the addon's six `@node-datachannel/<platform>` packages are
// `optionalDependencies` because only one of them installs on any given
// machine, and reading `dependencies` alone left them neither `external` nor
// covered by `assertNothingInlined`.
const sidecarManifest = JSON.parse(readFileSync(path.resolve(sidecar, 'package.json'), 'utf8'));
const SIDECAR_RUNTIME_DEPS = Object.keys({
  ...sidecarManifest.dependencies,
  ...sidecarManifest.optionalDependencies,
});
// Each package by name, plus every subpath export of it (`node-datachannel/polyfill`).
const NATIVE_DIRECT = SIDECAR_RUNTIME_DEPS.flatMap((name) => [name, `${name}/*`]);
// The list `assertNothingInlined` checks is this same one, so a manifest that
// stopped declaring the addon would take the check away with the `external`
// entry and the build would go green on a `burrow.cjs` that cannot load it.
if (!SIDECAR_RUNTIME_DEPS.includes('node-datachannel')) {
  throw new Error(
    'sidecar: package.json no longer declares "node-datachannel" under "dependencies" — it would ' +
      'be inlined into burrow.cjs, and nothing before the first direct-offer on a real machine ' +
      'would notice.',
  );
}

const bundles = [
  { entry: 'iframe-proxy.ts', out: 'iframe-proxy.cjs' },
  { entry: 'browser-host.ts', out: 'browser-host.cjs' },
  { entry: 'agent-browser-host.ts', out: 'agent-browser-host.cjs' },
  { entry: 'playwright-host.ts', out: 'playwright-host.cjs' },
  { entry: 'tool-host.ts', out: 'tool-host.cjs' },
  { entry: 'git-info.ts', out: 'git-info.cjs' },
  { entry: 'recovery.ts', out: 'recovery.cjs' },
  {
    entry: 'remote/sidecar-entry.ts',
    out: 'burrow.cjs',
    define: { [CONNECT_SRC_PLACEHOLDER]: JSON.stringify(remoteSrc) },
    assertBaked: true,
    external: NATIVE_DIRECT,
  },
];

/**
 * Fail the build if esbuild inlined a package the sidecar installs at runtime.
 *
 * `native-direct-peer.ts` calls `require('<specifier>')` by literal, so an
 * external specifier stays a `require-call` edge out of the bundle while a
 * bundled one becomes an input of it. That difference is the whole check: an
 * inlined addon produces a `burrow.cjs` that loads and then cannot find the
 * addon's `.node` file, which nothing before the first `direct-offer` on a real
 * machine would notice.
 */
function assertNothingInlined(metafile, outfile, names) {
  // esbuild keys `metafile.outputs` by path relative to the process cwd, with
  // `/` separators on every platform.
  const outputKey = path.relative(process.cwd(), outfile).split(path.sep).join('/');
  const output = metafile.outputs[outputKey];
  if (!output) {
    throw new Error(
      `sidecar: esbuild metafile has no output for "${outputKey}" — cannot check what it bundled.`,
    );
  }
  for (const name of names) {
    // Every layout a package manager resolves through ends in this segment,
    // pnpm's content-addressed store included.
    const inlined = Object.keys(output.inputs).find((input) =>
      input.includes(`node_modules/${name}/`),
    );
    if (!inlined) continue;
    throw new Error(
      `sidecar: ${outputKey} inlined "${inlined}" — "${name}" is a sidecar runtime dependency, and ` +
        'the addon would look for its platform package beside the bundle instead of inside ' +
        'sidecar/node_modules.',
    );
  }
}

// `tauri.conf.json`'s `bundle.resources` globs this whole directory, so a
// pre-rename `remote-host.cjs` left in an older checkout would ship inside the
// app — a dead Burrow with its own baked connect-src allowlist — and so would
// an `alert-store.cjs` from before the alerts joined `burrow.cjs`.
for (const retired of ['remote-host.cjs', 'alert-store.cjs']) {
  await rm(path.resolve(sidecar, retired), { force: true });
}

for (const { entry, out, define, assertBaked, external } of bundles) {
  const outfile = path.resolve(sidecar, out);
  const result = await build({
    entryPoints: [path.resolve(libHost, entry)],
    outfile,
    bundle: true,
    platform: 'node', // node builtins (http/net/fs/child_process) stay external
    // Match the frontend and VS Code host's dor/* source mapping. Host modules
    // also share the CLI's pure file-format registry.
    alias: { dor: path.resolve(here, '../../dor/src') },
    format: 'cjs',
    target: 'node24',
    // `ws`'s optional native accelerators stay unresolved rather than bundled.
    external: ['bufferutil', 'utf-8-validate', ...(external ?? [])],
    logLevel: 'warning',
    ...(define ? { define } : {}),
    // Only the bundle with externals to check reads one.
    ...(external ? { metafile: true } : {}),
  });
  if (assertBaked) assertConnectSrcBaked(outfile, remoteSrc);
  if (external) assertNothingInlined(result.metafile, outfile, SIDECAR_RUNTIME_DEPS);
  console.log(`[sidecar] built ${path.relative(process.cwd(), outfile)}`);
}

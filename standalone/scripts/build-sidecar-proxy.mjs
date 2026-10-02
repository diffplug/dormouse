// Bundle the host-agnostic host modules (shared with the VS Code extension host)
// into CommonJS files the Node sidecar can require. Keeps each as a single
// TypeScript source while the sidecar itself stays plain CJS.
//   - lib/src/host/iframe-proxy.ts        → sidecar/iframe-proxy.cjs
//   - lib/src/host/browser-host.ts        → sidecar/browser-host.cjs
//   - lib/src/host/agent-browser-host.ts  → sidecar/agent-browser-host.cjs
//   - lib/src/host/playwright-host.ts     → sidecar/playwright-host.cjs
//   - lib/src/host/tool-host.ts           → sidecar/tool-host.cjs
//   - lib/src/host/git-info.ts            → sidecar/git-info.cjs
//   - lib/src/host/remote/sidecar-entry.ts → sidecar/burrow.cjs (the alerts and managed voice too)
//   - lib/src/host/recovery.ts             → sidecar/recovery.cjs
// See docs/specs/dor-browser.md, docs/specs/remote-api.md,
// docs/specs/standalone.md -> "Agent recovery", and docs/specs/alert.md.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import {
  assertRelayOriginBaked,
  relayOriginDefine,
  resolveRelayOrigin,
} from '../../scripts/relay-origin.mjs';
import { assertNothingInlined } from '../../scripts/assert-not-inlined.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const libHost = path.resolve(here, '../../lib/src/host');
const sidecar = path.resolve(here, '../sidecar');

// The one relay origin, and the mode it sets. The Burrow runs in the sidecar,
// so this bundle is the enforcement point — there is no webview CSP in front of
// it. `--dev` marks a dev build (docs/specs/burrow-service.md → "Relay origin").
const relay = resolveRelayOrigin(process.env, 'sidecar', { dev: process.argv.includes('--dev') });

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
    define: relayOriginDefine(relay),
    assertBaked: true,
    external: NATIVE_DIRECT,
  },
];

// `tauri.conf.json`'s `bundle.resources` globs this whole directory, so a
// pre-rename `remote-host.cjs` left in an older checkout would ship inside the
// app — a dead Burrow with its own baked relay origin — and so would
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
    // Match the frontend and VS Code host's dor/*, dor-tools-builtin/*, and
    // dor-tools-lib/* source mappings. Host modules share the built-in viewers'
    // pure format registry and parse OSC 367 with dor-tools-lib.
    alias: {
      dor: path.resolve(here, '../../dor/src'),
      'dor-tools-builtin': path.resolve(here, '../../dor-tools-builtin/src'),
      'dor-tools-lib': path.resolve(here, '../../dor-tools-lib/src'),
    },
    format: 'cjs',
    target: 'node24',
    // `ws`'s optional native accelerators stay unresolved rather than bundled.
    external: ['bufferutil', 'utf-8-validate', ...(external ?? [])],
    logLevel: 'warning',
    ...(define ? { define } : {}),
    // Only the bundle with externals to check reads one.
    ...(external ? { metafile: true } : {}),
  });
  if (assertBaked) assertRelayOriginBaked(outfile, relay);
  if (external) assertNothingInlined(result.metafile, SIDECAR_RUNTIME_DEPS, `sidecar ${out}`);
  console.log(`[sidecar] built ${path.relative(process.cwd(), outfile)}`);
}

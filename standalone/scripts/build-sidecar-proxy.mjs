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

const bundles = [
  { entry: 'iframe-proxy.ts', out: 'iframe-proxy.cjs' },
  { entry: 'agent-browser-host.ts', out: 'agent-browser-host.cjs' },
  {
    entry: 'remote/sidecar-entry.ts',
    out: 'burrow.cjs',
    define: { [CONNECT_SRC_PLACEHOLDER]: JSON.stringify(remoteSrc) },
    assertBaked: true,
  },
];

// `tauri.conf.json`'s `bundle.resources` globs this whole directory, so a
// pre-rename `remote-host.cjs` left in an older checkout would ship inside the
// app — a dead Burrow with its own baked connect-src allowlist.
await rm(path.resolve(sidecar, 'remote-host.cjs'), { force: true });

for (const { entry, out, define, assertBaked } of bundles) {
  const outfile = path.resolve(sidecar, out);
  await build({
    entryPoints: [path.resolve(libHost, entry)],
    outfile,
    bundle: true,
    platform: 'node', // node builtins (http/net/fs/child_process) stay external
    format: 'cjs',
    target: 'node24',
    logLevel: 'warning',
    ...(define ? { define } : {}),
  });
  if (assertBaked) assertConnectSrcBaked(outfile, remoteSrc);
  console.log(`[sidecar] built ${path.relative(process.cwd(), outfile)}`);
}

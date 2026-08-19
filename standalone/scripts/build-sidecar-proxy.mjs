// Bundle the host-agnostic host modules (shared with the VS Code extension host)
// into CommonJS files the Node sidecar can require. Keeps each as a single
// TypeScript source while the sidecar itself stays plain CJS.
//   - lib/src/host/iframe-proxy.ts        → sidecar/iframe-proxy.cjs
//   - lib/src/host/agent-browser-host.ts  → sidecar/agent-browser-host.cjs
//   - lib/src/host/remote/sidecar-entry.ts → sidecar/remote-host.cjs
// See docs/specs/dor-browser.md and docs/specs/remote-api.md.
import { build } from 'esbuild';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveRemoteConnectSrc } from '../../scripts/csp-defaults.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const libHost = path.resolve(here, '../../lib/src/host');
const sidecar = path.resolve(here, '../sidecar');

// Where the remote Host may reach a relay server. The Host runs in the sidecar,
// so this is the enforcement point — there is no webview CSP in front of it.
const remoteSrc = resolveRemoteConnectSrc(process.env, 'sidecar');
const CONNECT_SRC_PLACEHOLDER = '__DORMOUSE_REMOTE_CONNECT_SRC__';

const bundles = [
  { entry: 'iframe-proxy.ts', out: 'iframe-proxy.cjs' },
  { entry: 'agent-browser-host.ts', out: 'agent-browser-host.cjs' },
  {
    entry: 'remote/sidecar-entry.ts',
    out: 'remote-host.cjs',
    define: { [CONNECT_SRC_PLACEHOLDER]: JSON.stringify(remoteSrc) },
    assertBaked: true,
  },
];

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
  // The source reads the placeholder as a `declare const`, so a lost define
  // compiles fine and only fails at runtime — as a Host that silently falls back
  // to the shipped default allowlist. Fail the build instead, like the VS Code
  // side does (vscode-ext/scripts/esbuild.mjs).
  if (assertBaked) {
    const bundled = readFileSync(outfile, 'utf8');
    if (bundled.includes(CONNECT_SRC_PLACEHOLDER)) {
      throw new Error(
        `connect-src: ${CONNECT_SRC_PLACEHOLDER} survived into ${out} — the esbuild define did not apply.`,
      );
    }
    if (!bundled.includes(remoteSrc)) {
      throw new Error(`connect-src: ${out} does not contain the resolved sources (${remoteSrc}).`);
    }
  }
  console.log(`[sidecar] built ${path.relative(process.cwd(), outfile)}`);
}

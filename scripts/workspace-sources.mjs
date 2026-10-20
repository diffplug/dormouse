// The one map from each internal workspace package to its source. What only
// bundles or type-checks reads these packages from here — bundlers through
// `workspaceSourceAliases()`, `noEmit` tsconfigs through
// `tsconfig.workspace-sources.json` — so it never reads a `dist` that is stale
// or missing. `scripts/workspace-sources.test.mjs` fails on a config that
// resolves them some other way, or on a package with `exports` missing here.
//
// What emits a `dist` of its own or runs in plain Node — the packages' `tsc`
// builds, the `dor` CLI bundle, `relay`, each package's `node --test` suite, and
// build scripts such as `scripts/relay-origin.mjs` — reads upstream `dist`
// instead, which `scripts/build-workspace-deps.mjs` builds first.

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each internal package's source directory, relative to the repo root. */
export const WORKSPACE_SOURCES = {
  'dormouse-lib': 'lib/src',
  dor: 'dor/src',
  'dor-lib-common': 'dor-lib-common/src',
  'dor-tools-builtin': 'dor-tools-builtin/src',
  'dor-tools-lib': 'dor-tools-lib/src',
  'remote-lib-common': 'remote-lib-common/src',
};

/**
 * Vite, vitest, and esbuild `alias` entries. A string alias matches the bare
 * name and every `name/…` subpath, and a directory resolves to its `index.ts`.
 */
export function workspaceSourceAliases() {
  return Object.fromEntries(Object.entries(WORKSPACE_SOURCES).map(([name, dir]) => [name, path.join(root, dir)]));
}

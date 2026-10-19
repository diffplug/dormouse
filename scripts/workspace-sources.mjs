// The one map from each internal workspace package to its source. Every
// bundler, test runner, and type checker that reaches one of these packages
// resolves it here — bundlers through `workspaceSourceAliases()`, tsc through
// `tsconfig.workspace-sources.json` — so none of them ever reads a `dist` that
// is stale or missing. `scripts/workspace-sources.test.mjs` fails on a config
// that resolves them some other way, or a package with `exports` missing here.
//
// What runs in plain Node — a package's own `node --test` suite, `relay`, the
// `dor` CLI bundle, and build scripts such as `scripts/relay-origin.mjs` — still
// reads `dist`; `scripts/build-workspace-deps.mjs` builds that first.

import { existsSync } from 'node:fs';
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

/**
 * The tsconfig `paths` entries for a config in `configDir`, which tsc resolves
 * relative to that config: `tsconfig.workspace-sources.json`'s, or those of a
 * config that needs paths of its own and so cannot extend it. A package with a
 * `src/index.ts` also maps its bare name.
 */
export function workspaceSourcePaths(configDir) {
  const paths = {};
  for (const [name, dir] of Object.entries(WORKSPACE_SOURCES)) {
    const relative = path.relative(configDir, path.join(root, dir)).split(path.sep).join('/');
    const target = relative.startsWith('..') ? relative : `./${relative}`;
    if (existsSync(path.join(root, dir, 'index.ts'))) paths[name] = [`${target}/index.ts`];
    paths[`${name}/*`] = [`${target}/*`];
  }
  return paths;
}

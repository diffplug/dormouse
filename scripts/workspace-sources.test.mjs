// Pins the rule `scripts/workspace-sources.mjs` states: bundlers and type
// checkers read the internal packages from source, and only
// `scripts/build-workspace-deps.mjs` builds their `dist`.

import assert from 'node:assert/strict';
import path from 'node:path';
import { test } from 'node:test';
import { readRepoFile, repoRoot, trackedFiles } from './lint-kit.mjs';
import { workspaceDeps, workspacePackages } from './workspace-packages.mjs';
import { WORKSPACE_SOURCES, workspaceSourcePaths } from './workspace-sources.mjs';

const BASE = 'tsconfig.workspace-sources.json';
const packages = [...workspacePackages().values()];

/** The workspace package `file` belongs to: the one with the longest matching dir. */
function owner(file) {
  return packages.filter(({ dir }) => file.startsWith(`${dir}/`)).sort((a, b) => b.dir.length - a.dir.length)[0];
}
const hasWorkspaceDeps = (file) => workspaceDeps(owner(file)?.manifest ?? {}).length > 0;

/** tsconfig is JSONC: drop comments outside strings, then trailing commas. */
function readJsonc(file) {
  const stripped = readRepoFile(file).replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ''));
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'));
}
const isWorkspaceKey = (key) => Object.keys(WORKSPACE_SOURCES).some((name) => key === name || key.startsWith(`${name}/`));

test('the source map covers every workspace package another one imports as a dist', () => {
  const missing = packages.filter(({ manifest }) => manifest.exports && !(manifest.name in WORKSPACE_SOURCES));
  assert.deepEqual(missing.map(({ manifest }) => manifest.name), []);
});

test('every Vite, vitest, Storybook, and build-script esbuild config takes its aliases from workspaceSourceAliases()', () => {
  const configs = trackedFiles().filter((f) =>
    /(^|\/)(vite|vitest)[^/]*\.config\.(ts|mts|js|mjs)$|(^|\/)\.storybook\/main\.ts$/.test(f)
    || (/(^|\/)scripts\/[^/]+\.mjs$/.test(f) && /from ['"]esbuild['"]/.test(readRepoFile(f))));
  assert.ok(configs.length > 10, `found only ${configs.length} configs`);
  const offenders = configs.filter((file) => {
    const text = readRepoFile(file);
    // A config built on a sibling config (mergeConfig, a spread) inherits its aliases.
    const extendsSibling = /from ['"]\.\/(vite|vitest)[^'"]*\.config(\.[mc]?ts)?['"]/.test(text);
    return hasWorkspaceDeps(file) && !text.includes('workspaceSourceAliases()') && !extendsSibling;
  });
  assert.deepEqual(offenders, []);
});

test(`every tsconfig that type-checks a package with workspace deps extends ${BASE}, or maps the same paths itself`, () => {
  assert.deepEqual(readJsonc(BASE).compilerOptions.paths, workspaceSourcePaths(repoRoot));
  for (const file of trackedFiles().filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f) && f !== BASE)) {
    const config = readJsonc(file);
    const options = config.compilerOptions ?? {};
    if (!options.paths && !(options.noEmit && hasWorkspaceDeps(file))) continue;
    if (options.paths) {
      // Its own `paths` replace the base's, so it must carry them all.
      const own = Object.fromEntries(Object.entries(options.paths).filter(([key]) => isWorkspaceKey(key)));
      assert.deepEqual(own, workspaceSourcePaths(path.join(repoRoot, path.dirname(file))), file);
    } else {
      assert.equal(path.join(path.dirname(file), config.extends ?? ''), BASE, `${file} must extend ${BASE}`);
    }
  }
});

test('no package.json script builds an internal package dist by name; build-workspace-deps derives the set', () => {
  const distPackages = packages.filter(({ manifest }) => manifest.exports).map(({ manifest }) => manifest.name);
  const offenders = [];
  for (const { dir, manifest } of [...packages, { dir: '.', manifest: JSON.parse(readRepoFile('package.json')) }]) {
    for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
      for (const name of distPackages) {
        if (new RegExp(`(--filter|-F)[ =]${name}(\\s|$).*\\bbuild\\b`).test(command)) offenders.push(`${dir}: ${script} builds ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'call `node ../scripts/build-workspace-deps.mjs` instead');
});

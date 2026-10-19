// Pins the rule `scripts/workspace-sources.mjs` states: bundlers and type
// checkers read the internal packages from source, and only
// `scripts/build-workspace-deps.mjs` builds their `dist`.

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { WORKSPACE_SOURCES, workspaceSourcePaths } from './workspace-sources.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tracked = execFileSync('git', ['ls-files'], { cwd: root, encoding: 'utf8' }).split('\n').filter(Boolean);
const read = (file) => readFileSync(path.join(root, file), 'utf8');

/** tsconfig is JSONC: drop comments outside strings, then trailing commas. */
function parseJsonc(text) {
  const stripped = text.replace(/"(?:[^"\\]|\\.)*"|\/\/[^\n]*|\/\*[\s\S]*?\*\//g, (m) => (m.startsWith('"') ? m : ''));
  return JSON.parse(stripped.replace(/,(\s*[}\]])/g, '$1'));
}

const manifests = new Map(
  tracked.filter((f) => f.endsWith('package.json') && !f.includes('node_modules'))
    .map((f) => [path.dirname(f), JSON.parse(read(f))]),
);
const hasWorkspaceDeps = (manifest) =>
  Object.values({ ...manifest.dependencies, ...manifest.devDependencies }).some((spec) => String(spec).startsWith('workspace:'));

test('every Vite, vitest, Storybook, and build-script esbuild config takes its aliases from workspace-sources', () => {
  const configs = tracked.filter((f) =>
    /(^|\/)(vite|vitest)[^/]*\.config\.(ts|mts|js|mjs)$|(^|\/)\.storybook\/main\.ts$/.test(f)
    || (/(^|\/)scripts\/[^/]+\.mjs$/.test(f) && /from ['"]esbuild['"]/.test(read(f))));
  assert.ok(configs.length > 10, `found only ${configs.length} configs`);
  const offenders = configs.filter((file) => {
    const text = read(file);
    // A config built on a sibling config (mergeConfig, a spread) inherits its aliases.
    const extendsSibling = /from ['"]\.\/(vite|vitest)[^'"]*\.config(\.[mc]?ts)?['"]/.test(text);
    const reachesWorkspace = Object.keys(WORKSPACE_SOURCES).some((name) => text.includes(`/${name}/src`) || text.includes(`'${name}'`) || text.includes(`"${name}"`));
    const usesHelper = text.includes('workspace-sources.mjs');
    // A config that names no internal package and has no workspace deps (canopy) needs nothing.
    const packageDir = file.split('/')[0];
    const needsHelper = reachesWorkspace || hasWorkspaceDeps(manifests.get(packageDir) ?? {});
    return needsHelper && !usesHelper && !extendsSibling;
  });
  assert.deepEqual(offenders, [], 'resolve internal packages with workspaceSourceAliases() from scripts/workspace-sources.mjs');
});

test('every tsconfig that maps paths, or type-checks a package with workspace deps, maps them all to source', () => {
  const configs = tracked.filter((f) => /(^|\/)tsconfig[^/]*\.json$/.test(f));
  for (const file of configs) {
    const options = parseJsonc(read(file)).compilerOptions ?? {};
    const manifest = manifests.get(path.dirname(file)) ?? {};
    if (!options.paths && !(options.noEmit && hasWorkspaceDeps(manifest))) continue;
    const expected = workspaceSourcePaths(path.join(root, path.dirname(file)));
    const actual = Object.fromEntries(Object.entries(options.paths ?? {}).filter(([key]) =>
      Object.keys(WORKSPACE_SOURCES).some((name) => key === name || key.startsWith(`${name}/`))));
    assert.deepEqual(actual, expected, `${file}: its "paths" must carry workspaceSourcePaths() from scripts/workspace-sources.mjs`);
  }
});

test('no script builds an internal package dist by name; build-workspace-deps derives the set', () => {
  const distPackages = [...manifests.values()].filter((m) => m.exports).map((m) => m.name);
  const offenders = [];
  for (const [dir, manifest] of manifests) {
    for (const [script, command] of Object.entries(manifest.scripts ?? {})) {
      for (const name of distPackages) {
        if (new RegExp(`--filter ${name}(\\s|$).*\\bbuild\\b`).test(command)) offenders.push(`${dir || '.'}: ${script} builds ${name}`);
      }
    }
  }
  assert.deepEqual(offenders, [], 'call `node ../scripts/build-workspace-deps.mjs` instead');
});

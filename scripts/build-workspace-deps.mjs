// Builds the `dist` of every internal package the calling package reaches
// through its `workspace:` dependencies, in dependency order. Bundlers and type
// checkers read those packages from source (`scripts/workspace-sources.mjs`);
// this covers what runs in plain Node and imports a `dist` — a package's own
// `node --test` suite, a bundled CLI, a build script such as
// `scripts/relay-origin.mjs`. A package's `pre*` script calls it instead of
// naming its upstream builds by hand, so the set follows `package.json` and
// cannot fall behind it.
//
// Only a package that declares `exports` — a `dist` others import — is built;
// `dormouse-lib` and `dor` are read as source or staged by their own steps.
// Each package it builds runs its own `prebuild`, which calls this script
// again; the variable below makes that nested call a no-op, since the outer run
// already selected the whole closure and pnpm orders it.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

const NESTED = 'DORMOUSE_BUILDING_WORKSPACE_DEPS';
if (process.env[NESTED]) process.exit(0);

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const packages = new Map();
for (const dir of YAML.parse(readFileSync(path.join(root, 'pnpm-workspace.yaml'), 'utf8')).packages) {
  const manifest = readJson(path.join(root, dir, 'package.json'));
  packages.set(manifest.name, manifest);
}

const workspaceDeps = (manifest) =>
  Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, spec]) => String(spec).startsWith('workspace:'))
    .map(([name]) => name);

const reached = new Set();
const pending = workspaceDeps(readJson(path.resolve('package.json')));
while (pending.length) {
  const name = pending.pop();
  if (reached.has(name)) continue;
  reached.add(name);
  pending.push(...workspaceDeps(packages.get(name)));
}

const builds = [...reached].filter((name) => packages.get(name).exports && packages.get(name).scripts?.build);
if (builds.length === 0) process.exit(0);

const result = spawnSync('pnpm', [...builds.flatMap((name) => ['--filter', name]), 'run', 'build'], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, [NESTED]: '1' },
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);

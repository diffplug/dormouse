// Builds the `dist` of every internal package the calling package reaches
// through its `workspace:` dependencies, in dependency order. Bundlers and type
// checkers read those packages from source (`scripts/workspace-sources.mjs`);
// this covers what runs in plain Node and imports a `dist` — a package's own
// `node --test` suite, a bundled CLI, a build script such as
// `scripts/relay-origin.mjs`. A package's `pre*` script calls it instead of
// naming its upstream builds by hand, so the set follows `package.json` and
// cannot fall behind it.
//
// Only a package that declares `exports` — a `dist` others import — is built
// or walked through; `dormouse-lib` and `dor` are read as source or staged by
// their own steps. Each package it builds runs its own `prebuild`, which calls
// this script again; the variable below makes that nested call a no-op, since
// the outer run already selected the whole closure and pnpm orders it.

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { workspaceDeps, workspacePackages } from './workspace-packages.mjs';

const NESTED = 'DORMOUSE_BUILDING_WORKSPACE_DEPS';
if (process.env[NESTED]) process.exit(0);

const packages = workspacePackages();
const builds = new Set();
const pending = workspaceDeps(JSON.parse(readFileSync(path.resolve('package.json'), 'utf8')));
while (pending.length) {
  const name = pending.pop();
  const { manifest } = packages.get(name);
  if (builds.has(name) || !manifest.exports || !manifest.scripts?.build) continue;
  builds.add(name);
  pending.push(...workspaceDeps(manifest));
}
if (builds.size === 0) process.exit(0);

const result = spawnSync('pnpm', [...[...builds].flatMap((name) => ['--filter', name]), 'run', 'build'], {
  cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'),
  stdio: 'inherit',
  env: { ...process.env, [NESTED]: '1' },
  shell: process.platform === 'win32',
});
process.exit(result.status ?? 1);

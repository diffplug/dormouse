// The workspace packages `pnpm-workspace.yaml` lists, and the `workspace:`
// edges between them — what `scripts/build-workspace-deps.mjs` walks and
// `scripts/workspace-sources.test.mjs` checks configs against.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

export const workspaceRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** Each workspace package's manifest, keyed by its name, with `dir` relative to the repo root. */
export function workspacePackages() {
  const packages = new Map();
  for (const dir of YAML.parse(readFileSync(path.join(workspaceRoot, 'pnpm-workspace.yaml'), 'utf8')).packages) {
    const manifest = JSON.parse(readFileSync(path.join(workspaceRoot, dir, 'package.json'), 'utf8'));
    packages.set(manifest.name, { dir, manifest });
  }
  return packages;
}

/** The workspace packages `manifest` depends on, dev dependencies included. */
export function workspaceDeps(manifest) {
  return Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
    .filter(([, spec]) => String(spec).startsWith('workspace:'))
    .map(([name]) => name);
}

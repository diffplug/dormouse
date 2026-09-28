// Stages `node-datachannel` into `dist/node_modules` with every platform's
// addon (docs/specs/vscode.md → "The direct path").
//
// pnpm installs only the host's `@node-datachannel/<platform>` package, so this
// has pnpm deploy the extension's production closure for every os and cpu into
// a scratch directory — fetched, verified against `pnpm-lock.yaml`, and cached
// by pnpm itself — then copies out the addon, its runtime dependencies, and the
// platform packages `package.json` declares.

import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ADDON = 'node-datachannel';

const extRoot = fileURLToPath(new URL('..', import.meta.url));
const target = path.join(extRoot, 'dist', 'node_modules');
// Relative and space-free, so the Windows `shell` spawn below needs no quoting;
// outside `vscode-ext/`, since deploy copies the package it deploys.
const deployDir = '../node_modules/.cache/dormouse-native-direct';

const manifest = readJson(path.join(extRoot, 'package.json'));
const platforms = Object.keys(manifest.optionalDependencies ?? {}).filter((name) =>
  name.startsWith('@node-datachannel/'),
);
if (!manifest.dependencies?.[ADDON] || platforms.length === 0) {
  throw new Error(
    `stage-native-direct: vscode-ext/package.json must declare "${ADDON}" under "dependencies" and its ` +
      'platform packages under "optionalDependencies" — without them the VSIX ships no direct path.',
  );
}

rmSync(target, { recursive: true, force: true });
rmSync(path.join(extRoot, deployDir), { recursive: true, force: true });
execFileSync(
  'pnpm',
  // The target first: `--os`, `--cpu`, and `--libc` are variadic.
  [
    '--filter', manifest.name, 'deploy', deployDir, '--prod', '--ignore-scripts', '--node-linker', 'hoisted',
    '--os', 'darwin,linux,win32', '--cpu', 'x64,arm64', '--libc', 'glibc',
  ],
  { cwd: extRoot, stdio: ['ignore', 'ignore', 'inherit'], shell: process.platform === 'win32' },
);
const deployed = path.join(extRoot, deployDir, 'node_modules');

// Hoisted, so every package sits at the top of `deployed`.
const stage = (name) => {
  const dest = path.join(target, name);
  if (existsSync(dest)) return;
  cpSync(path.join(deployed, name), dest, { recursive: true });
  for (const dep of Object.keys(readJson(path.join(dest, 'package.json')).dependencies ?? {})) stage(dep);
};
stage(ADDON);
for (const name of platforms) {
  stage(name);
  if (!existsSync(path.join(target, name, 'node_datachannel.node'))) {
    throw new Error(`stage-native-direct: ${name} has no node_datachannel.node.`);
  }
}
rmSync(path.join(extRoot, deployDir), { recursive: true, force: true });

console.error(`[stage-native-direct] ${ADDON} with ${platforms.length} platform addons`);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

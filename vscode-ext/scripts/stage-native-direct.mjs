// Stages `node-datachannel` into `dist/node_modules` with every platform's
// prebuilt addon, so one universal VSIX answers the direct path on every
// platform VS Code runs on (docs/specs/vscode.md → "The direct path").
//
// pnpm installs only the host's platform package. The rest are fetched from the
// registry and checked against the integrity `pnpm-lock.yaml` pins, so the VSIX
// carries the same bytes a `pnpm install` on each platform would. Tarballs are
// cached under `node_modules/.cache`, so only the first build needs the network.
//
// Staged as `dist/node_modules` rather than beside `dist/node-pty` because the
// addon's loader resolves its platform package and `detect-libc` by bare name
// from its own `__dirname`, and `native-direct-peer.ts` requires the addon by
// bare name from `dist/extension.js`.

import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

const ADDON = 'node-datachannel';
const PLATFORM_SCOPE = '@node-datachannel/';

const extRoot = fileURLToPath(new URL('..', import.meta.url));
const target = path.join(extRoot, 'dist', 'node_modules');
const cacheDir = path.join(extRoot, 'node_modules', '.cache', 'dormouse-native-direct');
const registry = (process.env.npm_config_registry || 'https://registry.npmjs.org/').replace(/\/?$/, '/');

const manifest = readJson(path.join(extRoot, 'package.json'));
const lockfile = readFileSync(path.join(extRoot, '..', 'pnpm-lock.yaml'), 'utf8');

const platforms = Object.entries(manifest.optionalDependencies ?? {}).filter(([name]) =>
  name.startsWith(PLATFORM_SCOPE),
);
if (!manifest.dependencies?.[ADDON] || platforms.length === 0) {
  throw new Error(
    `stage-native-direct: vscode-ext/package.json must declare "${ADDON}" under "dependencies" and its ` +
      `${PLATFORM_SCOPE}* packages under "optionalDependencies" — without them the VSIX ships no direct path.`,
  );
}

rmSync(target, { recursive: true, force: true });

// The addon and its runtime dependencies, copied from the install.
const addonDir = stageInstalled(ADDON, extRoot);
const addonVersion = readJson(path.join(addonDir, 'package.json')).version;

for (const [name, version] of platforms) {
  // The loader requires the platform package without a version check, so a
  // mismatched pair would load a binary built against another JS half.
  if (version !== addonVersion) {
    throw new Error(`stage-native-direct: ${name}@${version} does not match ${ADDON}@${addonVersion}.`);
  }
  const dest = path.join(target, name);
  const installed = findPackageDir(name, addonDir);
  if (installed && readJson(path.join(installed, 'package.json')).version === version) {
    cpSync(installed, dest, { recursive: true, dereference: true });
  } else {
    extractPackage(await fetchTarball(name, version), dest);
  }
  const staged = readJson(path.join(dest, 'package.json'));
  if (staged.name !== name || staged.version !== version || !existsSync(path.join(dest, 'node_datachannel.node'))) {
    throw new Error(`stage-native-direct: ${dest} is not ${name}@${version} with its node_datachannel.node.`);
  }
}

console.error(`[stage-native-direct] ${ADDON}@${addonVersion} with ${platforms.length} platform addons`);

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/**
 * Node's own lookup: `node_modules/<name>` in `from` and each ancestor. Real
 * paths, because pnpm links a package's dependencies beside its store copy
 * rather than beside the symlink an importer sees.
 */
function findPackageDir(name, from) {
  for (let dir = from; ; dir = path.dirname(dir)) {
    const candidate = path.join(dir, 'node_modules', name);
    if (existsSync(path.join(candidate, 'package.json'))) return realpathSync(candidate);
    if (path.dirname(dir) === dir) return null;
  }
}

/** Copy an installed package and, recursively, its `dependencies`. */
function stageInstalled(name, from) {
  const dir = findPackageDir(name, from);
  if (!dir) throw new Error(`stage-native-direct: "${name}" is not installed (run pnpm install).`);
  const dest = path.join(target, name);
  if (!existsSync(dest)) {
    cpSync(dir, dest, { recursive: true, dereference: true });
    for (const dep of Object.keys(readJson(path.join(dir, 'package.json')).dependencies ?? {})) {
      stageInstalled(dep, dir);
    }
  }
  return dir;
}

/** The `sha512-…` integrity `pnpm-lock.yaml` pins for `name@version`. */
function lockedIntegrity(name, version) {
  const escaped = `${name}@${version}`.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');
  const match = new RegExp(`\\n  '?${escaped}'?:\\n    resolution: \\{integrity: (sha512-[A-Za-z0-9+/=]+)`).exec(
    lockfile,
  );
  if (!match) throw new Error(`stage-native-direct: pnpm-lock.yaml pins no integrity for ${name}@${version}.`);
  return match[1];
}

async function fetchTarball(name, version) {
  const integrity = lockedIntegrity(name, version);
  const cached = path.join(cacheDir, `${name.replace('/', '+')}-${version}.tgz`);
  const verify = (bytes) => `sha512-${createHash('sha512').update(bytes).digest('base64')}` === integrity;
  if (existsSync(cached)) {
    const bytes = readFileSync(cached);
    if (verify(bytes)) return bytes;
  }
  const url = `${registry}${name}/-/${name.slice(PLATFORM_SCOPE.length)}-${version}.tgz`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`stage-native-direct: ${url} answered ${response.status}.`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (!verify(bytes)) {
    throw new Error(`stage-native-direct: ${url} does not match the integrity pnpm-lock.yaml pins.`);
  }
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(cached, bytes);
  return bytes;
}

/**
 * Unpack an npm tarball's `package/` tree into `dest`. npm packs plain ustar
 * entries — regular files, directories, and pax headers, which carry nothing a
 * prebuilt package needs — so anything else is refused rather than guessed at.
 */
function extractPackage(tgz, dest) {
  const tar = gunzipSync(tgz);
  const field = (header, start, length) => header.toString('utf8', start, start + length).replace(/\0.*$/s, '');
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const size = parseInt(field(header, 124, 12).trim() || '0', 8);
    const type = field(header, 156, 1) || '0';
    const prefix = field(header, 345, 155);
    const entry = (prefix ? `${prefix}/` : '') + field(header, 0, 100);
    const body = tar.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x' || type === 'g') continue;
    const rel = entry.replace(/^package\//, '');
    if (rel === entry || rel.split('/').includes('..') || path.isAbsolute(rel)) {
      throw new Error(`stage-native-direct: unexpected tarball entry "${entry}".`);
    }
    const out = path.join(dest, rel);
    if (type === '5') {
      mkdirSync(out, { recursive: true });
    } else if (type === '0') {
      mkdirSync(path.dirname(out), { recursive: true });
      writeFileSync(out, body);
    } else {
      throw new Error(`stage-native-direct: tarball entry "${entry}" has unsupported type "${type}".`);
    }
  }
}

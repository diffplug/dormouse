import { chmodSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

function relativePath(path) {
  if (!path || path.split('/').some(part => !part || part === '.' || part === '..') || /[\\\r\n:]/.test(path)) {
    throw new Error(`Invalid artifact path: ${JSON.stringify(path)}`);
  }
  return path;
}

const MANIFEST = 'artifact-manifest.sha256';
const EXECUTABLES = 'artifact-executables.txt';

function lines(file) {
  return readFileSync(file, 'utf8').trimEnd().split('\n');
}

/**
 * Hash verification alone does not reject extra code injected into a cached app.
 * Returns the validated executable paths, so the caller that acts on them reads
 * the same parse that vetted them.
 */
export function verifyInventory(root) {
  const actual = new Set();
  function walk(dir, prefix = '') {
    for (const name of readdirSync(dir)) {
      const path = prefix + name;
      relativePath(path);
      const stat = lstatSync(join(root, path));
      if (stat.isDirectory()) walk(join(root, path), `${path}/`);
      else if (stat.isFile()) actual.add(path);
      else throw new Error(`Artifact contains a symlink or special file: ${path}`);
    }
  }
  walk(root);
  if (!actual.delete(MANIFEST)) throw new Error('Artifact manifest is missing');
  const listed = new Set();
  for (const line of lines(join(root, MANIFEST))) {
    const match = /^([0-9a-fA-F]{64}) [ *](.+)$/.exec(line);
    if (!match) throw new Error('Malformed SHA-256 manifest record');
    const path = relativePath(match[2]);
    if (listed.has(path)) throw new Error(`Duplicate manifest path: ${path}`);
    listed.add(path);
    if (!actual.delete(path)) throw new Error(`Manifest file is missing: ${path}`);
  }
  if (actual.size) throw new Error(`Unlisted artifact files: ${[...actual].join(', ')}`);

  if (!listed.has(EXECUTABLES)) return [];
  const content = readFileSync(join(root, EXECUTABLES), 'utf8');
  const executables = content ? content.replace(/\n$/, '').split('\n') : [];
  const seen = new Set();
  for (const path of executables) {
    relativePath(path);
    if (!listed.has(path) || path === EXECUTABLES) throw new Error(`Unlisted executable: ${path}`);
    if (seen.has(path)) throw new Error(`Duplicate executable: ${path}`);
    seen.add(path);
  }
  return executables;
}

/** Only call on a working copy whose manifest and hashes have been verified. */
export function restoreExecutables(root) {
  for (const path of verifyInventory(root)) chmodSync(join(root, path), 0o755);
}

if (process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, root] = process.argv.slice(2);
    if (!root || !['verify', 'restore'].includes(command)) throw new Error('Usage: release-artifact.mjs verify|restore ARTIFACT_DIR');
    if (command === 'verify') verifyInventory(root);
    else restoreExecutables(root);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

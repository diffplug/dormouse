#!/usr/bin/env node
// Download a checksum-pinned, unmodified upstream Worker; never run package hooks.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const root = fileURLToPath(new URL('.', import.meta.url));
const release = JSON.parse(await readFile(join(root, 'release.json'), 'utf8'));
if (!/^\d+\.\d+\.\d+$/.test(release.version) || !/^[a-f0-9]{64}$/.test(release.archiveSha256)) {
  throw new Error('Invalid pinned release');
}
const name = `blygger-worker-${release.version}`;
const stage = join(root, '.staging', release.version);
await mkdir(stage, { recursive: true });
const response = await fetch(`https://github.com/blygger/blygger-studio/releases/download/v${release.version}/${name}.tar.gz`);
if (!response.ok) throw new Error(`Bundle download failed: HTTP ${response.status}`);
const archive = Buffer.from(await response.arrayBuffer());
if (createHash('sha256').update(archive).digest('hex') !== release.archiveSha256) {
  throw new Error('Bundle checksum mismatch; nothing installed');
}
const path = join(stage, `${name}.tar.gz`);
await writeFile(path, archive);
const entries = execFileSync('tar', ['-tzf', path], { encoding: 'utf8' }).trim().split('\n');
if (entries.some(entry => !entry.startsWith(`${name}/`) || entry.split('/').includes('..'))) {
  throw new Error('Unsafe archive path');
}
const types = execFileSync('tar', ['-tvzf', path], { encoding: 'utf8' }).trim().split('\n');
if (types.some(entry => !['-', 'd'].includes(entry[0]))) throw new Error('Archive contains a link or special file');
await rm(join(stage, name), { recursive: true, force: true });
execFileSync('tar', ['-xzf', path, '-C', stage]);
await readFile(join(stage, name, 'worker.js'));
await rm(join(root, '.bundle'), { recursive: true, force: true });
await rename(join(stage, name), join(root, '.bundle'));
console.log(`Installed official Studio ${release.version} in deploy/blyg/.bundle (SHA-256 verified).`);

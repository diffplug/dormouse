import { chmod, cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '..', '..');
const sourceRoot = resolve(repoRoot, 'dor');
const targetRoot = resolve(repoRoot, 'standalone', 'sidecar', 'dor-cli');

await rm(targetRoot, { recursive: true, force: true });
await mkdir(targetRoot, { recursive: true });
await cp(resolve(sourceRoot, 'bin'), resolve(targetRoot, 'bin'), { recursive: true });
await cp(resolve(sourceRoot, 'dist'), resolve(targetRoot, 'dist'), { recursive: true });

if (process.platform !== 'win32') {
  await chmod(resolve(targetRoot, 'bin', 'dor'), 0o755);
}

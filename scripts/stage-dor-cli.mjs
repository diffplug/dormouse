import { chmod, cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const repoRoot = resolve(scriptDir, '..');

export async function stageDorCli(targetPath) {
  if (!targetPath) {
    throw new Error('usage: node scripts/stage-dor-cli.mjs <target-dir>');
  }

  const sourceRoot = resolve(repoRoot, 'dor');
  const targetRoot = resolve(repoRoot, targetPath);

  await rm(targetRoot, { recursive: true, force: true });
  await mkdir(targetRoot, { recursive: true });
  await cp(resolve(sourceRoot, 'bin'), resolve(targetRoot, 'bin'), { recursive: true });
  await cp(resolve(sourceRoot, 'dist'), resolve(targetRoot, 'dist'), { recursive: true });
  await writeFile(
    resolve(targetRoot, 'package.json'),
    `${JSON.stringify({
      name: 'dor',
      private: true,
      type: 'module',
      bin: {
        dor: './dist/dor.js',
      },
    }, null, 2)}\n`,
  );

  if (process.platform !== 'win32') {
    await chmod(resolve(targetRoot, 'bin', 'dor'), 0o755);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await stageDorCli(process.argv[2]);
}

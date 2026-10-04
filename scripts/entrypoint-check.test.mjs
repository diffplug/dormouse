import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

// A script that runs its main only when it is the entrypoint must compare real
// paths: `import.meta.url` has symlinks resolved and `process.argv[1]` does not,
// so `argv[1] === fileURLToPath(import.meta.url)` and its variants silently skip
// main, and exit 0, when the script is reached through a symlink.
test('every entrypoint check compares real paths', () => {
  const files = execFileSync('git', ['ls-files', '*.mjs', '*.js', '*.cjs', '*.ts'], { cwd: ROOT, encoding: 'utf8' }).trim().split('\n');
  const unsafe = [];
  for (const file of files) {
    const lines = readFileSync(`${ROOT}/${file}`, 'utf8').split('\n');
    lines.forEach((line, i) => {
      const window = lines.slice(Math.max(0, i - 2), i + 3).join(' ');
      if (line.includes('import.meta.url') && window.includes('process.argv[1]') && !window.includes('realpathSync(process.argv[1])')) {
        unsafe.push(`${file}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  assert.deepEqual(unsafe, [], 'use `process.argv[1] && realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)`');
});

/**
 * Every lint self-test (`scripts/*-lint-selftest.mjs`) runs in a sandbox copy
 * of the tree (`makeSelftest` in `scripts/lint-kit.mjs`) and never writes the
 * checkout: a planted line another reader sees is a false finding, and one an
 * interrupted run leaves behind is a real one. This is how the root
 * `pnpm test` runs them — all at once — and it fails if one fails, or if any
 * tracked file was written afterwards (its change time moves even when the
 * bytes are put back), or a path appeared in or left `git status`.
 *
 * A self-test is found by its name, so a new one is covered without being
 * listed here.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { gitPaths, repoRoot } from './lint-kit.mjs';

const SELFTESTS = readdirSync(join(repoRoot, 'scripts'))
  .filter((name) => name.endsWith('-lint-selftest.mjs'))
  .sort();

/** Each tracked file's size and change time, and every path git reports beside them. */
function snapshot() {
  const files = new Map();
  for (const rel of gitPaths()) {
    const stat = lstatSync(join(repoRoot, rel), { throwIfNoEntry: false });
    files.set(rel, stat ? `${stat.size} bytes, ctime ${stat.ctimeMs}` : 'missing');
  }
  // Untracked and ignored paths too, so a planted file or a backup is seen.
  const status = execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  return { files, status: status.split('\0').filter(Boolean) };
}

function changes(before, after) {
  const changed = [];
  for (const [rel, state] of before.files) if (after.files.get(rel) !== state) changed.push(`changed: ${rel}`);
  for (const rel of after.files.keys()) if (!before.files.has(rel)) changed.push(`now tracked: ${rel}`);
  const was = new Set(before.status);
  const is = new Set(after.status);
  for (const line of after.status) if (!was.has(line)) changed.push(`appeared in git status: ${line}`);
  for (const line of before.status) if (!is.has(line)) changed.push(`left git status: ${line}`);
  return changed;
}

function run(script) {
  return new Promise((resolve) => {
    execFile('node', [join(repoRoot, 'scripts', script)], { cwd: repoRoot, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) =>
      resolve({ script, code: error ? (error.code ?? error.signal) : 0, output: `${stdout}${stderr}` }),
    );
  });
}

test('every lint self-test passes and leaves the checkout untouched', async () => {
  for (const lint of ['deploy', 'e2e', 'loopback', 'outbound', 'ps1-cmdlet', 'spec']) {
    assert.ok(SELFTESTS.includes(`${lint}-lint-selftest.mjs`), `scripts/${lint}-lint-selftest.mjs is missing, so pnpm test no longer runs it`);
  }
  const before = snapshot();
  const results = await Promise.all(SELFTESTS.map(run));
  const after = snapshot();

  const changed = changes(before, after);
  assert.equal(changed.length, 0, `a lint self-test wrote the checkout; it must plant only in its sandbox\n  ${changed.join('\n  ')}`);
  for (const { script, code, output } of results) assert.equal(code, 0, `${script} failed:\n${output}`);
});

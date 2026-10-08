/**
 * Every lint self-test (`scripts/*-lint-selftest.mjs`) plants its violations in
 * a sandbox (`makeSandbox` in `scripts/lint-kit.mjs`) and never writes the
 * checkout: a planted line another reader sees is a false finding, and one an
 * interrupted run leaves behind is a real one. This runs them all, at once, and
 * requires every tracked file to be untouched afterwards — the same bytes and
 * the same change time, so an edit that was put back still counts — and no
 * file to have appeared or vanished.
 *
 * A self-test discovered by name is covered without being listed here.
 */

import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstatSync, readdirSync, readFileSync, readlinkSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { repoRoot } from './lint-kit.mjs';

const SELFTESTS = readdirSync(join(repoRoot, 'scripts'))
  .filter((name) => name.endsWith('-lint-selftest.mjs'))
  .sort();

const git = (...args) => execFileSync('git', args, { cwd: repoRoot, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });

/** Each tracked file's bytes and change time, and every path git reports beside them. */
function snapshot() {
  const files = new Map();
  for (const rel of git('ls-files', '-z').split('\0').filter(Boolean)) {
    const path = join(repoRoot, rel);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat) files.set(rel, 'missing');
    else if (stat.isDirectory()) continue;
    else {
      const bytes = stat.isSymbolicLink() ? readlinkSync(path) : readFileSync(path);
      files.set(rel, `${createHash('sha256').update(bytes).digest('hex')} ctime ${stat.ctimeMs}`);
    }
  }
  // Untracked and ignored paths too, so a planted file or a backup is seen.
  const status = git('status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching');
  return { files, status: status.split('\0').filter(Boolean).sort() };
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
  assert.ok(SELFTESTS.length >= 6, `expected the lint self-tests under scripts/, found ${SELFTESTS.join(', ')}`);
  const before = snapshot();
  const results = await Promise.all(SELFTESTS.map(run));
  const after = snapshot();

  const changed = changes(before, after);
  assert.equal(changed.length, 0, `a lint self-test wrote the checkout; it must plant only in its sandbox\n  ${changed.join('\n  ')}`);
  for (const { script, code, output } of results) assert.equal(code, 0, `${script} failed:\n${output}`);
});

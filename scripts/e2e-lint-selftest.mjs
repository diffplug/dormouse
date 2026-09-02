#!/usr/bin/env node
/**
 * Proves `e2e-lint.mjs` is load-bearing: for every rule, re-introduce exactly
 * the thing it forbids and require the lint to fail.
 *
 * Why this exists, and why it is the inverse of `deploy-lint-selftest.mjs`: the
 * installer lint checks that controls are *present*, so removing one is the
 * test. Every rule here checks that something is *absent*, and the
 * characteristic failure of an absence check is passing because the pattern
 * cannot see the thing it names — a regex anchored on a spelling nobody uses, a
 * scope that resolves to no files, a `SECURITY.md` phrase that drifted. A green
 * `e2e-lint` says nothing about any of that. "The lint goes red when each
 * forbidden thing comes back" is the property that matters, and it is checkable.
 *
 * How each kind is violated:
 *   - `forbid`  — append the pattern's own text to a file inside the rule's
 *                 scope. This also proves the scope resolves: a `trees` rule
 *                 whose filter excluded every file would stay green.
 *   - `exactly` — append one more use, proving the count is a comparison rather
 *                 than a floor. A floor silently absorbs the next addition,
 *                 which is how a counted-sites rule stops counting.
 *   - `absent`  — create the file.
 *   - `require` — delete the matched text.
 *
 * Every rule also names a `SECURITY.md` line, and the lint checks that line
 * still exists. That check is proved here too, by deleting the line: a rule
 * whose prose was removed is a rule nobody agreed to, and it must not go on
 * passing quietly.
 *
 * Restores every file it touches on any thrown error. A signal mid-run (Ctrl-C,
 * a cancelled job) can leave a `*.e2e-selftest.bak` beside an edited file; the
 * backups are gitignored, and `git status` shows the edit.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { filesFor, RULES } from './e2e-lint.mjs';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Run the real lint in a child, so a thrown rule cannot pass as a failure. */
function lintFails() {
  try {
    execFileSync('node', [join(repoRoot, 'scripts', 'e2e-lint.mjs')], { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

const weak = [];
let held = 0;

/** Edit `relative` with `mutate`, run the lint, and restore it. */
function withMutation(relative, mutate, label) {
  const path = join(repoRoot, relative);
  const existed = existsSync(path);
  const backup = `${path}.e2e-selftest.bak`;
  if (existed) copyFileSync(path, backup);
  try {
    mutate(path);
    if (lintFails()) held += 1;
    else weak.push(label);
  } finally {
    if (existed) {
      copyFileSync(backup, path);
      rmSync(backup, { force: true });
    } else {
      rmSync(path, { force: true });
    }
  }
}

for (const rule of RULES) {
  const name = rule.rule;

  if (rule.kind === 'absent') {
    withMutation(
      rule.path,
      (path) => writeFileSync(path, rule.violation),
      `${name}\n      creating ${rule.path} stays green — the lint is not looking where it says it is`,
    );
  } else if (rule.kind === 'require') {
    const path = join(repoRoot, rule.file);
    const original = readFileSync(path, 'utf8');
    const match = original.match(rule.pattern);
    if (!match) {
      weak.push(`${name}\n      pattern does not match the pristine ${rule.file}`);
    } else {
      withMutation(
        rule.file,
        (p) => writeFileSync(p, original.replace(match[0], '')),
        `${name}\n      removing ${match[0]} from ${rule.file} stays green`,
      );
    }
  } else {
    // `forbid` and `exactly`: put the forbidden thing back. For `exactly` this
    // is one *extra* use, which is what makes the count a comparison rather
    // than a floor.
    const scope = filesFor(rule);
    if (!scope.includes(rule.violationFile)) {
      weak.push(
        `${name}\n      the violation file ${rule.violationFile} is outside the rule's own scope — the case would prove nothing`,
      );
      continue;
    }
    withMutation(
      rule.violationFile,
      (path) => writeFileSync(path, readFileSync(path, 'utf8') + rule.violation),
      rule.kind === 'exactly'
        ? `${name}\n      an added use stays green — the count must compare exactly, not as a floor`
        : name,
    );
  }

  // The SECURITY.md cross-check, per rule: deleting the line the rule names
  // must redden the lint, or a rule can outlive the prose that authorized it.
  const securityPath = join(repoRoot, 'SECURITY.md');
  const security = readFileSync(securityPath, 'utf8');
  if (!security.includes(rule.security)) {
    weak.push(`${name}\n      SECURITY.md does not contain the line this rule names`);
    continue;
  }
  withMutation(
    'SECURITY.md',
    (path) => writeFileSync(path, security.replace(rule.security, '')),
    `${name}\n      deleting its SECURITY.md line stays green — the rule would outlive the prose`,
  );
}

if (weak.length > 0) {
  console.error('e2e-lint-selftest: checks that stayed green when they should have gone red\n');
  for (const w of weak) console.error(`  ${w}\n`);
  console.error(
    'A rule that stays green with the forbidden thing present is looking at the\n' +
      'wrong text, or at no files at all — check the pattern spelling and that the\n' +
      "rule's scope still resolves. For an added copy on an exact-count rule, the\n" +
      'fix is in e2e-lint.mjs, not the pattern.',
  );
  process.exit(1);
}

console.log(`e2e-lint-selftest: OK (${held}/${held} checks are load-bearing)`);

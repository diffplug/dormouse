#!/usr/bin/env node
/**
 * Proves `deploy-lint.mjs` is load-bearing: for every rule × installer, delete
 * exactly the text the pattern matches and require the lint to fail.
 *
 * Why this exists: a textual lint's characteristic failure is passing for the
 * wrong reason. Review of the first version found three rules that stayed green
 * after the control they name was deleted, because the pattern also matched
 * something unrelated — `\b64\b` hit two `exit 64` lines and the entropy
 * guard's own explanatory comment, so the prose *about* the rule satisfied the
 * rule. A sweep then found two more the review had not sampled. Asserting "the
 * lint passes" says nothing about any of that; asserting "the lint fails when
 * each control is removed" is the property that matters.
 *
 * This is not a claim that the patterns are *sufficient* — a control can be
 * present and wrong, and the security audit still owns that. It is only a claim
 * that each pattern is anchored on its own control rather than on incidental
 * text elsewhere in the file.
 *
 * Restores every file it touches, including on failure.
 */

import { copyFileSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

import { INSTALLERS, RULES } from './deploy-lint.mjs';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** Run the real lint in a child, so a thrown rule cannot pass as a failure. */
function lintFails() {
  try {
    execFileSync('node', [join(repoRoot, 'scripts', 'deploy-lint.mjs')], { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

const weak = [];
let held = 0;

for (const { rule, patterns, skip = {}, minMatches = {} } of RULES) {
  for (const { platform, file } of INSTALLERS) {
    if (platform in skip) continue;
    const pattern = patterns[platform];
    if (!pattern) continue;

    const path = join(repoRoot, file);
    const original = readFileSync(path, 'utf8');
    const match = original.match(pattern);
    if (!match) {
      weak.push(`${platform.padEnd(8)} ${rule}\n      pattern does not match the pristine file`);
      continue;
    }

    // Remove one occurrence. For a control the installer writes twice on
    // purpose, `minMatches` is what makes removing either one a failure.
    const backup = `${path}.selftest.bak`;
    copyFileSync(path, backup);
    try {
      writeFileSync(path, original.replace(match[0], ''));
      if (lintFails()) held += 1;
      else weak.push(`${platform.padEnd(8)} ${rule}`);
    } finally {
      copyFileSync(backup, path);
      rmSync(backup, { force: true });
    }
  }
}

if (weak.length > 0) {
  console.error('deploy-lint-selftest: rules that stay green after their control is removed\n');
  for (const w of weak) console.error(`  ${w}\n`);
  console.error(
    'Each pattern above matches text that is not the control — usually the\n' +
      'identifier rather than the message or comparison, or a comment that\n' +
      'describes the rule. Anchor it on something only the control itself says.',
  );
  process.exit(1);
}

console.log(`deploy-lint-selftest: OK (${held}/${held} rules are load-bearing)`);

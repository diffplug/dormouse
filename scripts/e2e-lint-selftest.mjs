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
 * `RULES`' own doc in `e2e-lint.mjs` states what each kind's `violation` is; a
 * `forbid` or `exactly` case appends it inside the rule's own scope, which also
 * proves that scope resolves — a `trees` rule whose filter excluded every file
 * would stay green.
 *
 * Every rule also names a `SECURITY.md` line, and the lint checks that line
 * still exists. That check is proved here too, by deleting the line: a rule
 * whose prose was removed is a rule nobody agreed to, and it must not go on
 * passing quietly. Once per *line*, not once per rule — several rules cite the
 * same sentence, and re-deleting it proves nothing new.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeSelftest, repoRoot } from './lint-kit.mjs';
import { filesFor, RULES } from './e2e-lint.mjs';

const selftest = makeSelftest('e2e-lint.mjs', '.e2e-selftest.bak');

for (const rule of RULES) {
  const name = rule.rule;

  if (rule.kind === 'require') {
    // The one kind whose violation is a deletion: the lint requires the text,
    // so removing it is what must redden.
    const original = readFileSync(join(repoRoot, rule.file), 'utf8');
    const match = original.match(rule.pattern);
    if (!match) {
      selftest.weak.push(`${name}\n      pattern does not match the pristine ${rule.file}`);
      continue;
    }
    selftest.withMutation(
      rule.file,
      (path) => writeFileSync(path, original.replace(match[0], '')),
      `${name}\n      removing ${match[0]} from ${rule.file} stays green`,
    );
    continue;
  }

  if (rule.kind === 'absent') {
    selftest.withAppended(
      rule.path,
      rule.violation,
      `${name}\n      creating ${rule.path} stays green — the lint is not looking where it says it is`,
    );
    continue;
  }

  // `forbid` and `exactly`: put the forbidden thing back. For `exactly` this is
  // one *extra* use, which is what makes the count a comparison rather than a
  // floor — a floor silently absorbs the next addition.
  if (!filesFor(rule).includes(rule.violationFile)) {
    selftest.weak.push(
      `${name}\n      the violation file ${rule.violationFile} is outside the rule's own scope — the case would prove nothing`,
    );
    continue;
  }
  selftest.withAppended(
    rule.violationFile,
    rule.violation,
    rule.kind === 'exactly'
      ? `${name}\n      an added use stays green — the count must compare exactly, not as a floor`
      : name,
  );
}

const security = readFileSync(join(repoRoot, 'SECURITY.md'), 'utf8');
for (const line of new Set(RULES.map((rule) => rule.security))) {
  if (!security.includes(line)) {
    selftest.weak.push(`SECURITY.md does not contain the line a rule names: "${line}"`);
    continue;
  }
  selftest.withMutation(
    'SECURITY.md',
    (path) => writeFileSync(path, security.replace(line, '')),
    `deleting "${line}" from SECURITY.md stays green — a rule would outlive the prose`,
  );
}

selftest.finish(
  'e2e-lint-selftest',
  'A rule that stays green with the forbidden thing present is looking at the\n' +
    'wrong text, or at no files at all — check the pattern spelling and that the\n' +
    "rule's scope still resolves. For an added copy on an exact-count rule, the\n" +
    'fix is in e2e-lint.mjs, not the pattern.',
);

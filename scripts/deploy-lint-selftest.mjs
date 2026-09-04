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
 * This is not a claim that the patterns are *sufficient*, and there is one gap
 * worth naming because this file looks like it covers it. Removing the *matched*
 * text proves that match is load-bearing; it says nothing about a second copy of
 * the same control that the pattern never matched. A review found exactly that:
 * the identity rule matched one call site per platform, so macOS's post-switch
 * wait — the one whose failure rolls back and dies — was deletable with this
 * self-test green. `exactMatches` in `deploy-lint.mjs` is what covers that, and
 * it has to be set per platform from a counted list of the real call sites. For
 * those rules this file also proves the exactness itself is load-bearing, by
 * adding a copy and requiring the lint to fail — a floor would stay green and
 * silently re-arm the counted-sites gap on the next addition. A control can
 * also be present and wrong; the security audit still owns that.
 *
 * Restores every file it touches on any thrown error. A signal mid-run (Ctrl-C,
 * a cancelled job) is the one gap: it can leave an installer with one control
 * deleted and a `*.selftest.bak` beside it. `deploy-lint` catches that on the
 * way in, and the backups are gitignored so they cannot be staged by accident.
 */

import { writeFileSync } from 'node:fs';

import { makeSelftest, readRepoFile } from './lint-kit.mjs';
import { INSTALLERS, RULES } from './deploy-lint.mjs';

const selftest = makeSelftest('deploy-lint.mjs', '.selftest.bak');

for (const {
  rule,
  patterns,
  skip = {},
  exactMatches = {},
  forbidden = false,
  violation,
  violations,
} of RULES) {
  for (const { platform, file } of INSTALLERS) {
    if (platform in skip) continue;
    const pattern = patterns[platform];
    if (!pattern) continue;

    // A forbidden rule is the inverse: deleting nothing proves nothing, so the
    // mutation is to ADD the thing the spec bans and require the lint to fail.
    // Without this the rule is a claim that something is checked — a pattern
    // that matches nothing passes whether or not it could ever match.
    if (forbidden) {
      if (pattern.test(readRepoFile(file))) {
        selftest.weak.push(
          `${platform.padEnd(8)} ${rule}\n      pattern already matches the pristine file`,
        );
        continue;
      }
      const platformViolations = violations?.[platform] ?? (violation ? [violation] : []);
      if (platformViolations.length === 0) {
        selftest.weak.push(
          `${platform.padEnd(8)} ${rule}\n      no forbidden-text mutation is defined`,
        );
        continue;
      }
      for (const forbiddenText of platformViolations) {
        selftest.withAppended(
          file,
          `\n${forbiddenText}\n`,
          `${platform.padEnd(8)} ${rule}\n      forbidden shape ${JSON.stringify(forbiddenText)} stays green — the rule checks nothing`,
        );
      }
      continue;
    }

    // Matched and edited in the same normalized form the lint reads, so a
    // `core.autocrlf` checkout does not report every span rule as unmatched.
    // The byte-exact backup `withMutation` takes is what the file is restored
    // from, so writing normalized text mid-run costs nothing.
    const original = readRepoFile(file);
    const match = original.match(pattern);
    if (!match) {
      selftest.weak.push(
        `${platform.padEnd(8)} ${rule}\n      pattern does not match the pristine file`,
      );
      continue;
    }

    // Remove one occurrence. For a control the installer writes at several
    // sites on purpose, `exactMatches` is what makes removing any one a failure.
    selftest.withMutation(
      file,
      (path) => writeFileSync(path, original.replace(match[0], '')),
      `${platform.padEnd(8)} ${rule}`,
    );

    // For an exact-count rule, an added copy must fail too — exact is what
    // forces a deliberate count bump when a new site appears, instead of a
    // floor silently absorbing it.
    if (exactMatches[platform] === undefined) continue;
    selftest.withAppended(
      file,
      `\n${match[0]}\n`,
      `${platform.padEnd(8)} ${rule}\n      an added copy stays green — the count must compare exactly, not as a floor`,
    );
  }
}

selftest.finish(
  'deploy-lint-selftest',
  'For a removed control: the pattern matches text that is not the control —\n' +
    'usually the identifier rather than the message or comparison, or a comment\n' +
    'that describes the rule. Anchor it on something only the control itself\n' +
    'says. For an added copy: the fix is in deploy-lint.mjs, not the pattern.',
);

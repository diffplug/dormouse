#!/usr/bin/env node
/**
 * Mechanical check for the self-host installer invariants in `SECURITY.md`
 * ("Credentials at rest", "Network posture (self-hosted)"). Runs from the repo
 * root via `pnpm test` (see the root package.json). Exits non-zero with a
 * per-violation report naming the rule that was broken.
 *
 * Why this exists: those `FAIL IF` lines bind all three installers, and until
 * now nothing executed them. No workflow parses `deploy/local/`, no script
 * references it, and the installers are the one part of the tree that CI never
 * touches — so the rules were enforced entirely by whoever remembered to read
 * them. The observed cost of that is real: the macOS `manage verify` checks
 * file modes but not owner while the Linux one checks both, which is the same
 * rule held to two different standards, found by an audit rather than a build.
 *
 * The check: every installer must still contain the load-bearing control each
 * rule names. This is a *textual* check on purpose — the same ceiling
 * `loopback-lint.mjs` states about itself.
 *
 * What it deliberately does NOT do, so nobody mistakes it for the whole rule:
 *   - It cannot tell whether a control is correct, only that it is still there.
 *     A `die` that no longer fires, or an entropy guard reading the wrong
 *     variable, passes here. The security audit still owns that.
 *   - It says nothing about the *generated* `manage` scripts beyond the fact
 *     that the installer writes the checks into them. Whether `manage verify`
 *     passes on a real install is what `manage verify` is for.
 *   - Windows is checked at the same depth as the other two, which is worth
 *     stating plainly: nothing in CI can execute PowerShell here, so for that
 *     file this lint is the *only* automated signal that a control survives.
 *
 * Adding an installer means adding it to INSTALLERS. A rule that genuinely does
 * not apply to a platform belongs in `skip` with a reason, not silently
 * omitted — an unexplained gap is how the owner-check divergence happened.
 */

import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** The three shipped installers, by the platform name the specs use. */
const INSTALLERS = [
  { platform: 'macOS', file: 'deploy/local/install-macos.sh' },
  { platform: 'Windows', file: 'deploy/local/install-windows.ps1' },
  { platform: 'Linux', file: 'deploy/local/install-linux.sh' },
];

/**
 * One entry per `FAIL IF` clause this can see. `pattern` is matched against the
 * whole file; `skip` names platforms the rule does not apply to, with a reason
 * that has to be stated rather than implied.
 */
const RULES = [
  {
    // The *refusal*, not the value: the literal `DORMOUSE_BIND_HOST=127.0.0.1`
    // also appears in the env-file heredoc, so matching it would keep passing
    // after the guard that enforces it was deleted.
    rule: 'Network posture — the install refuses to proceed without DORMOUSE_BIND_HOST=127.0.0.1',
    patterns: {
      macOS: /must set DORMOUSE_BIND_HOST=127\.0\.0\.1/,
      Linux: /must set DORMOUSE_BIND_HOST=127\.0\.0\.1/,
      Windows: /must set DORMOUSE_BIND_HOST=127\.0\.0\.1/,
    },
  },
  {
    rule: 'Credentials at rest — the setup password is generated locally from a CSPRNG',
    patterns: {
      macOS: /\/dev\/urandom/,
      Linux: /randomBytes\(32\)/,
      Windows: /RandomNumberGenerator/,
    },
  },
  {
    rule: 'Credentials at rest — the entropy guard counts 64 hex characters, not 32',
    patterns: {
      macOS: /-ge 64/,
      Linux: /-ge 64/,
      Windows: /\b64\b/,
    },
  },
  {
    rule: 'Credentials at rest — manage verify fails when the service definition carries the password',
    patterns: {
      macOS: /DORMOUSE_SETUP_PASSWORD/,
      Linux: /DORMOUSE_SETUP_PASSWORD/,
      Windows: /DORMOUSE_SETUP_PASSWORD/,
    },
  },
  {
    rule: 'Network posture — the installer refuses to rewrite a mismatched DORMOUSE_ORIGIN',
    patterns: {
      macOS: /refusing to silently rewrite the origin/,
      Linux: /refusing to silently rewrite the origin/,
      Windows: /refusing to silently rewrite the origin/,
    },
  },
  {
    rule: 'Network posture — the installer refuses to run privileged',
    patterns: {
      macOS: /id -u/,
      Linux: /id -u/,
      Windows: /Administrator/,
    },
  },
  {
    rule: 'Network posture — manage verify fails on an active Tailscale Funnel',
    patterns: {
      macOS: /funnel on/i,
      Linux: /funnel on/i,
      Windows: /funnel on/i,
    },
  },
  {
    rule: 'Credentials at rest — config/ and state/ are created owner-only',
    patterns: {
      macOS: /chmod 0700/,
      Linux: /chmod 0700/,
      Windows: /Protect-Path/,
    },
  },
  {
    rule: 'A 200 does not say who answered — health is paired with a release-identity check',
    patterns: {
      macOS: /listening_release/,
      Linux: /listening_release/,
      Windows: /Get-ListeningRelease/,
    },
  },
];

const failures = [];
let checked = 0;

for (const { rule, patterns, skip = {} } of RULES) {
  for (const { platform, file } of INSTALLERS) {
    if (platform in skip) continue;
    const pattern = patterns[platform];
    if (!pattern) {
      failures.push(`${rule}\n    ${file}: no pattern defined for ${platform}, and no stated skip`);
      continue;
    }
    checked += 1;
    let text;
    try {
      text = readFileSync(join(repoRoot, file), 'utf8');
    } catch {
      failures.push(`${rule}\n    ${file}: missing`);
      continue;
    }
    if (!pattern.test(text)) {
      failures.push(`FAIL IF ${rule}\n    ${file} no longer matches ${pattern}`);
    }
  }
}

if (failures.length > 0) {
  console.error('deploy-lint: the installers no longer hold controls SECURITY.md requires\n');
  for (const failure of failures) console.error(`  ${failure}\n`);
  console.error(
    'Each line above maps to a FAIL IF in SECURITY.md. If a control moved rather than\n' +
      'disappeared, update the pattern in scripts/deploy-lint.mjs in the same commit.',
  );
  process.exit(1);
}

console.log(
  `deploy-lint: OK (${INSTALLERS.length} installers, ${RULES.length} rules, ${checked} checks)`,
);

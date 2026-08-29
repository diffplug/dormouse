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
import { pathToFileURL } from 'node:url';

const repoRoot = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();

/** The three shipped installers, by the platform name the specs use. */
export const INSTALLERS = [
  { platform: 'macOS', file: 'deploy/local/install-macos.sh' },
  { platform: 'Windows', file: 'deploy/local/install-windows.ps1' },
  { platform: 'Linux', file: 'deploy/local/install-linux.sh' },
];

/**
 * One entry per `FAIL IF` clause this can see. `pattern` is matched against the
 * whole file; `skip` names platforms the rule does not apply to, with a reason
 * that has to be stated rather than implied.
 *
 * Every pattern must be anchored on the control's OWN text — a message it
 * prints, a comparison it makes — never on an identifier that appears
 * elsewhere in the file. A review found three rules satisfied by an unrelated
 * occurrence: `\b64\b` matched two `exit 64` lines and the entropy guard's own
 * explanatory comment, so the prose about the rule survived deleting the rule.
 * `scripts/deploy-lint-selftest.mjs` is what keeps that honest: it removes each
 * matched control in turn and requires this lint to fail.
 *
 * `minMatches` is for a control the installer writes twice on purpose — once in
 * its own body and once into the generated `manage` — where matching only one
 * would let the other be deleted silently.
 */
export const RULES = [
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
    // Anchored on each guard's own comparison. `-ge 64` occurs exactly once in
    // either shell installer, but a bare /64/ on Windows also matched two
    // `exit 64` argument-parse lines and the guard's *explanatory comment* —
    // so the prose about the rule survived deleting the rule.
    rule: 'Credentials at rest — the entropy guard counts 64 hex characters, not 32',
    patterns: {
      macOS: /-ge 64/,
      Linux: /-ge 64/,
      Windows: /\$SETUP_PASSWORD\.Length -lt 64/,
    },
  },
  {
    // Anchored on the failure message, not the identifier: the latter also
    // appears in the env heredoc, in `show-password`, and in the candidate
    // probe's throwaway password, so deleting the whole check left it green.
    // The character class covers the Windows copy, which says `config\\server.env`.
    rule: 'Credentials at rest — manage verify fails when the service definition carries the password',
    patterns: {
      macOS: /it must live only in config[\\/]server\.env/,
      Linux: /it must live only in config[\\/]server\.env/,
      Windows: /it must live only in config[\\/]server\.env/,
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
    // Anchored on the refusal itself. `id -u` also appears in the user-manager
    // preflight and in `owner_only`, and `Administrator` six times in ACL prose.
    rule: 'Network posture — the installer refuses to run privileged',
    patterns: {
      macOS: /do not run this as root/,
      Linux: /do not run this as root/,
      Windows: /IsInRole\(\[Security\.Principal\.WindowsBuiltInRole\]::Administrator\)/,
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
    // Anchored on the two paths that matter. A bare `chmod 0700` also matches
    // `run-server`, `manage` and the probe state dir, and `Protect-Path` has
    // six hits, so relaxing config/+state/ to 0755 passed.
    rule: 'Credentials at rest — config/ and state/ are created owner-only',
    patterns: {
      macOS: /chmod 0700 "\$CONFIG_DIR" "\$STATE_DIR"/,
      Linux: /chmod 0700 "\$CONFIG_DIR" "\$STATE_DIR"/,
      Windows: /Protect-Path -Path \$CONFIG_DIR -Directory/,
    },
  },
  {
    // Anchored on the comparison, not the helper's name — the name appears at
    // its definition and at every call site, so removing the check that
    // consumes it left this green.
    //
    // `minMatches` is doing the real work here, and it has to be set for every
    // platform. Each writes the conjunct at more than one site, and a pattern
    // that matched only one left the others deletable: on macOS the first
    // version matched the generated `manage`'s wait and left the post-switch
    // wait — the one whose failure rolls back and dies — unlinted. Counting is
    // what makes "every copy survives" checkable; the self-test cannot see it,
    // because it proves the *matched* text is load-bearing, never that every
    // copy of the control is matched.
    //
    // The counts, and where they come from:
    //   macOS   4 — `manage`'s wait_for_health, `manage verify`, the post-switch
    //               wait, the rollback wait
    //   Linux   2 — `service_healthy`, once in the body and once in `manage`
    //   Windows 4 — post-switch, Restore-PreviousRelease, `manage rollback`, `manage verify`
    // Windows names its comparison four different ways, so the pattern matches
    // the shape (an identity variable against an expected release) rather than
    // one spelling.
    //
    // macOS writes the comparison two ways, so its pattern carries both.
    // `manage verify` needs the release twice — once for the gate, once for the
    // failure message that names it — so it assigns `serving` first instead of
    // calling `listening_release` inline. A pattern that required the inline
    // form counted 3 sites and left `verify`'s deletable, while Windows counted
    // its structurally identical `manage verify` site: one rule, two standards.
    // `verify` is the audit command, so what a miss there loses is a green tick
    // a stranger's process earned. Only `=` is counted; the `!=` uses at the
    // post-failure diagnostics are reports, not gates.
    rule: 'A 200 does not say who answered — health is paired with a release-identity check',
    patterns: {
      macOS: /\[ "\$(?:\(listening_release "\$(?:LOOPBACK_)?PORT"\)|serving)" = "\$\w+" \]/,
      Linux: /&& \[ "\$\(listening_release "\$(?:LOOPBACK_)?PORT"\)" = "\$1" \]/,
      Windows: /\$(?:listening|restored|serving) -(?:ne|eq) \$(?:RELEASE_ID|OLD_RELEASE|prev|cur)\b/,
    },
    minMatches: { macOS: 4, Linux: 2, Windows: 4 },
  },
];

export function check() {
  const failures = [];
  let checked = 0;

  for (const { rule, patterns, skip = {}, minMatches = {} } of RULES) {
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
    const want = minMatches[platform] ?? 1;
    const found = text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`));
    if ((found?.length ?? 0) < want) {
      failures.push(
        `FAIL IF ${rule}\n    ${file} matches ${pattern} ${found?.length ?? 0}x, expected at least ${want}`,
      );
    }
  }
  }

  return { failures, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, checked } = check();
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
}

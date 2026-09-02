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

import { pathToFileURL } from 'node:url';

import { readRepoFile } from './lint-kit.mjs';

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
 * `exactMatches` is for a control the installer writes at several sites on
 * purpose — in its own body and into the generated `manage` — where matching
 * only one would let the others be deleted silently. Setting it is a claim that
 * *these are all the sites*, and the comparison is exact in both directions:
 * fewer matches means a control went missing, more means a site was added and
 * the count must be bumped deliberately in the same commit. Rules without it
 * require at least one match.
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
    // The rule above matches the generator's *body*, which the enrollment
    // token also keeps alive — so on its own it would stay green after
    // `SETUP_PASSWORD="$RANDOM"`. This pins the assignment, the parallel of the
    // enroll-token rule below.
    rule: 'Credentials at rest — the setup password comes from that named generator',
    patterns: {
      macOS: /SETUP_PASSWORD="\$\(random_hex32\)"/,
      Linux: /SETUP_PASSWORD="\$\(random_hex32\)"/,
      Windows: /\$SETUP_PASSWORD = New-RandomHex32/,
    },
  },
  {
    // Anchored on each guard's own comparison, naming the secret it guards: the
    // enrollment offer's token has a guard of the same shape, so a bare
    // `-ge 64` would be satisfied by either and neither would be load-bearing.
    // A bare /64/ on Windows was worse still — it also matched two `exit 64`
    // argument-parse lines and the guard's *explanatory comment*, so the prose
    // about the rule survived deleting the rule.
    rule: 'Credentials at rest — the entropy guard counts 64 hex characters, not 32',
    patterns: {
      macOS: /\$\{#SETUP_PASSWORD\} -ge 64/,
      Linux: /\$\{#SETUP_PASSWORD\} -ge 64/,
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
    // Anchored on the three paths that matter. A bare `chmod 0700` also matches
    // `run-server`, `manage` and the probe state dir, and `Protect-Path` has
    // six hits, so relaxing config/+state/ to 0755 passed.
    //
    // Every path is named, because a pattern that stops short of the last one
    // matches as a strict prefix of the line: `"$CONFIG_DIR" "$STATE_DIR"`
    // stayed green after `"$RUN_DIR"` — the offer's directory — was deleted
    // from the same chmod. Windows matches its three calls as one span for the
    // same reason; they are written as one block on purpose.
    rule: 'Credentials at rest — config/, state/ and run/ are created owner-only',
    patterns: {
      macOS: /chmod 0700 "\$CONFIG_DIR" "\$STATE_DIR" "\$RUN_DIR"/,
      Linux: /chmod 0700 "\$CONFIG_DIR" "\$STATE_DIR" "\$RUN_DIR"/,
      Windows:
        /Protect-Path -Path \$CONFIG_DIR -Directory\n\s*Protect-Path -Path \$STATE_DIR -Directory\n\s*Protect-Path -Path \$RUN_DIR -Directory/,
    },
  },
  {
    // The token is minted by the same named generator as the setup password —
    // one per installer, which the CSPRNG rule above matches at its definition.
    // Anchored on the mint itself: swapping in $RANDOM, a timestamp, or a
    // reused password would rewrite exactly this line.
    rule: 'Credentials at rest — the enroll token comes from the same CSPRNG as the setup password',
    patterns: {
      macOS: /ENROLL_TOKEN="\$\(random_hex32\)"/,
      Linux: /ENROLL_TOKEN="\$\(random_hex32\)"/,
      Windows: /\$enrollToken = New-RandomHex32/,
    },
  },
  {
    rule: "Credentials at rest — the enroll token's entropy guard counts 64 hex characters",
    patterns: {
      macOS: /\$\{#ENROLL_TOKEN\} -ge 64/,
      Linux: /\$\{#ENROLL_TOKEN\} -ge 64/,
      Windows: /\$enrollToken\.Length -lt 64/,
    },
  },
  {
    rule: 'Credentials at rest — hosts.json permanently closes installer offer bootstrap',
    patterns: {
      macOS:
        /if \[ -e "\$STATE_DIR\/hosts\.json" \]; then\n\s*rm -f "\$ENROLL_OFFER_FILE"/,
      Linux:
        /if \[ -e "\$STATE_DIR\/hosts\.json" \]; then\n\s*rm -f "\$ENROLL_OFFER_FILE"/,
      Windows:
        /if \(Test-Path -LiteralPath \(Join-Path \$STATE_DIR 'hosts\.json'\)\) \{\n\s*Remove-Item -LiteralPath \$ENROLL_OFFER_FILE/,
    },
  },
  {
    // The offer header is adjacent to the end of pruning, making it the last
    // state mutation before the read-only summary. Pinning that boundary catches
    // a move back above Serve without coupling the lint to every Serve command.
    rule: 'Credentials at rest — enrollment offer is minted after pruning and Serve',
    patterns: {
      macOS:
        /ok "pruned \$PRUNED old release\(s\); config and state untouched"\nfi\n\n# -+ enroll offer/,
      Linux:
        /ok "pruned \$PRUNED old release\(s\); config and state untouched"\nfi\n\n# -+ enroll offer/,
      Windows:
        /Write-Ok "pruned \$pruned old release\(s\); config and state untouched"\n  \}\n\n  # -+ enroll offer/,
    },
  },
  {
    // Two adjacent operations, matched as one span, because the control is their
    // ORDER: a same-directory temp file, restricted, and only then the token.
    //
    // BOTH operands are pinned. Leaving the second line's operand off — on the
    // theory that the line above already anchors the identifier's spelling, so
    // repeating it would pin spelling rather than order — left the rule
    // satisfied by restricting the WRONG file: `chmod 0600 "$ENV_FILE"` on the
    // line after the offer's truncation matched, and the offer stayed under the
    // directory's default permissions with the lint green.
    rule: 'Credentials at rest — the offer file is restricted to the installing user before the token is written',
    patterns: {
      macOS:
        /ENROLL_OFFER_TMP="\$\(mktemp "\$RUN_DIR\/\.enroll-offer\.XXXXXX"\)" \\\n\s*\|\| die "could not create a temporary enrollment offer\."\n\s*chmod 0600 "\$ENROLL_OFFER_TMP"/,
      Linux:
        /ENROLL_OFFER_TMP="\$\(mktemp "\$RUN_DIR\/\.enroll-offer\.XXXXXX"\)" \\\n\s*\|\| die "could not create a temporary enrollment offer\."\n\s*chmod 0600 "\$ENROLL_OFFER_TMP"/,
      Windows:
        /\[IO\.File\]::WriteAllText\(\$offerTemp, ''\)\n\s*Protect-Path -Path \$offerTemp\b/,
    },
  },
  {
    // Same-directory rename is the publication point: the live path contains a
    // complete old offer, a complete new offer, or nothing because redemption
    // claimed it — never an in-progress write.
    rule: 'Credentials at rest — the completed enrollment offer is published by atomic rename',
    patterns: {
      macOS: /mv -f "\$ENROLL_OFFER_TMP" "\$ENROLL_OFFER_FILE"/,
      Linux: /mv -f "\$ENROLL_OFFER_TMP" "\$ENROLL_OFFER_FILE"/,
      Windows: /fs\.renameSync\(process\.argv\[2\], process\.argv\[3\]\)/,
    },
  },
  {
    // The same ordering control on `config/server.env`, which SECURITY.md's
    // FAIL IF has always required and nothing checked. macOS reaches it with
    // `umask 077` covering the heredoc rather than a chmod on an empty file, so
    // that is what its pattern anchors; the other two bind both operands, for
    // the reason the rule above states.
    rule: 'Credentials at rest — config/server.env is restricted to the installing user before the password is written',
    patterns: {
      macOS: /umask 077\n\s*cat > "\$ENV_FILE"/,
      Linux: /: > "\$ENV_FILE"\n\s*chmod 0600 "\$ENV_FILE"/,
      Windows: /\[IO\.File\]::WriteAllText\(\$ENV_FILE, ''\)\n\s*Protect-Path -Path \$ENV_FILE\b/,
    },
  },
  {
    // `run/` is the whole claim — SECURITY.md's FAIL IF carries the why — so
    // the pattern pins the path segment and not the basename: a rename is not
    // this rule's business, and pinning it would redden the lint for the wrong
    // reason. Two lines as one span, because what decides the placement is the
    // offer deriving from that directory.
    //
    // Placement is textual; lifecycle is executable. CI's Linux test-mode
    // install requires rotation across two pre-enrollment runs, then creates
    // hosts.json and requires a third run to leave no offer.
    rule: 'Credentials at rest — the enrollment offer is written under run/, never config/ or state/',
    patterns: {
      macOS: /RUN_DIR="\$INSTALL_ROOT\/run"\n\s*ENROLL_OFFER_FILE="\$RUN_DIR\//,
      Linux: /RUN_DIR="\$INSTALL_ROOT\/run"\n\s*ENROLL_OFFER_FILE="\$RUN_DIR\//,
      Windows: /\$RUN_DIR = Join-Path \$INSTALL_ROOT 'run'\n\s*\$ENROLL_OFFER_FILE = Join-Path \$RUN_DIR /,
    },
  },
  {
    // Anchored on the comparison, not the helper's name — the name appears at
    // its definition and at every call site, so removing the check that
    // consumes it left this green.
    //
    // `exactMatches` is doing the real work here, and it has to be set for
    // every platform. Each writes the conjunct at more than one site, and a
    // pattern that matched only one left the others deletable: on macOS the
    // first version matched the generated `manage`'s wait and left the
    // post-switch wait — the one whose failure rolls back and dies — unlinted.
    // Counting is what makes "every copy survives" checkable; the self-test
    // cannot see it, because it proves the *matched* text is load-bearing,
    // never that every copy of the control is matched. The count was once a
    // floor, which meant a legitimately-added site silently re-armed the same
    // gap: the new site could later lose its identity conjunct without the
    // count dropping below the floor. Exact is what forces the bump.
    //
    // The counts, and where they come from:
    //   macOS   3 — `manage`'s wait_for_health, the post-switch wait, the
    //               rollback wait
    //   Linux   2 — `service_healthy`, once in the body and once in `manage`
    //   Windows 4 — post-switch, Restore-PreviousRelease, `manage rollback`, `manage verify`
    // Windows names its comparison four different ways, so the pattern matches
    // the shape (an identity variable against an expected release) rather than
    // one spelling.
    //
    // Every macOS comparison counted here calls `listening_release` inline, so
    // no match can be held up by a spelling that never consults it. `manage
    // verify` is the one macOS site that cannot be written that way — it needs
    // the answer twice, once for the gate and once for the failure message that
    // names the release — so it assigns `serving` first, and the rule below
    // covers it. Folding it in here instead, by accepting a bare
    // `[ "$serving" = "$x" ]` as a second spelling, looked free and was not:
    // that alternative is bound to nothing, so any of the sites above could be
    // rewritten into it — including the post-switch wait — and the count would
    // still read 4. Only `=` is counted; the `!=` uses at `install-macos.sh`
    // :675 and :1195 are post-failure diagnostics, reports rather than gates.
    rule: 'A 200 does not say who answered — health is paired with a release-identity check',
    patterns: {
      macOS: /\[ "\$\(listening_release "\$(?:LOOPBACK_)?PORT"\)" = "\$\w+" \]/,
      Linux: /&& \[ "\$\(listening_release "\$(?:LOOPBACK_)?PORT"\)" = "\$1" \]/,
      Windows: /\$(?:listening|restored|serving) -(?:ne|eq) \$(?:RELEASE_ID|OLD_RELEASE|prev|cur)\b/,
    },
    exactMatches: { macOS: 3, Linux: 2, Windows: 4 },
  },
  {
    // macOS `manage verify`'s half of the rule above, split out because it is
    // the one site that resolves the release into a variable first. `verify` is
    // the audit command, so a miss here is a green tick a stranger's process
    // earned — the outcome the rule above exists to prevent — and an earlier
    // pattern that demanded the inline spelling left it wholly unlinted while
    // Windows counted its structurally identical `verify` site: one rule, two
    // standards.
    //
    // All three parts are needed, which is why the pattern is an alternation
    // with an exact count of 3 rather than one pattern per part. A comparison
    // is only as good as both of its operands, so each is pinned to the thing
    // that has to have produced it: `serving` to `listening_release`, `cur_id`
    // to the `current` symlink. Editing any of the three parts drops the count
    // to 2 — deleting the comparison leaves the two lookups; rewriting
    // `serving="$cur_id"` leaves the comparison and the expected release;
    // rewriting `cur_id="$serving"` compares the port's holder to itself, so
    // `verify` green-ticks whatever answers. That last one is the same shape as
    // the first, on the other operand, and it stayed green until the count
    // reached 3. Matching the parts in one span instead would need a
    // `[\s\S]*?` gap between them, which the self-test cannot check honestly —
    // it deletes the matched text verbatim, so a match swallowing the lines
    // between would turn the lint red for the wrong reason and the self-test
    // could not tell.
    //
    // `local serving cur_id` is what makes this `verify`'s site and no other:
    // the two other macOS functions that declare `serving` pair it with `want`
    // and `old_id`. `$cur_id` anchors the comparison the same way, and the
    // `cur_id=` prefix anchors the symlink read — the file's three other
    // `basename readlink current` reads assign `want` or print inline.
    //
    // The other three macOS sites the rule above counts still bind only their
    // *served* operand: `want`, `old_id`, and `$RELEASE_ID` can each be
    // rewritten to whatever `listening_release` returned with the lint green.
    // Same for Windows's four. Closing that class is a wider change than this
    // site, and is left open deliberately — the analysis is in #482.
    rule: '`manage verify` resolves who holds the port, and compares it to the current release',
    patterns: {
      macOS:
        /local serving cur_id\n\s+serving="\$\(listening_release "\$PORT"\)"|cur_id="\$\(basename "\$\(readlink "\$ROOT\/current"|\[ "\$serving" = "\$cur_id" \]/,
    },
    skip: {
      Linux:
        'its `manage verify` gate calls `service_healthy`, so the comparison lives in that helper — counted by the rule above',
      Windows:
        'its `manage verify` assigns `$listening` the same way, but the Windows pattern counts a bare variable-vs-variable comparison, so that site is one of the four the rule above counts — unbound to `Get-ListeningRelease`, the gap named in the comment above',
    },
    exactMatches: { macOS: 3 },
  },
];

export function check() {
  const failures = [];
  let checked = 0;

  for (const { rule, patterns, skip = {}, exactMatches = {} } of RULES) {
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
      text = readRepoFile(file);
    } catch {
      failures.push(`${rule}\n    ${file}: missing`);
      continue;
    }
    const want = exactMatches[platform];
    const found =
      text.match(new RegExp(pattern.source, `${pattern.flags.replace('g', '')}g`))?.length ?? 0;
    if (want === undefined) {
      if (found < 1) {
        failures.push(`FAIL IF ${rule}\n    ${file} matches ${pattern} 0x, expected at least 1`);
      }
    } else if (found < want) {
      failures.push(
        `FAIL IF ${rule}\n    ${file} matches ${pattern} ${found}x, expected exactly ${want} — a control went missing`,
      );
    } else if (found > want) {
      failures.push(
        `FAIL IF ${rule}\n    ${file} matches ${pattern} ${found}x, expected exactly ${want} — if a site was added on purpose, bump exactMatches in the same commit`,
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

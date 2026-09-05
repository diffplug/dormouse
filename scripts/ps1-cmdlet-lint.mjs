#!/usr/bin/env node
/**
 * Every `Verb-Noun` call in `deploy/local/install-windows.ps1` uses a verb
 * PowerShell actually approves. Runs from the repo root via `pnpm test`.
 *
 * Why this exists: nothing else reads the `.ps1`. `deploy-lint.mjs` matches
 * text, `installer-verify-test.mjs` executes the *shell* helpers, and no job
 * has a PowerShell to parse with — so the Windows installer is the one shipped
 * file with no syntax gate at all. A repo-wide rename proved the cost by
 * turning all 147 `Write-Host` calls into `Write-Burrow`: a cmdlet that does
 * not exist, in a script that only fails on the operator's machine.
 *
 * Two checks, one per half of a `Verb-Noun` name, because a rename can mangle
 * either. The verb must come from PowerShell's closed approved set
 * (`Get-Verb`), and the noun must not be one of this project's own words —
 * there is no `Write-Burrow`, and there never will be. Neither knows whether
 * `Get-Foo` exists; together they cover what a find/replace actually does to a
 * cmdlet name. A locally defined `Verb-Noun` function passes as long as its
 * verb is approved, which is the naming convention anyway.
 *
 * `scripts/ps1-cmdlet-lint-selftest.mjs` plants the defect and requires this
 * to go red.
 */

import { pathToFileURL } from 'node:url';

import { readRepoFile } from './lint-kit.mjs';

export const INSTALLER = 'deploy/local/install-windows.ps1';

/**
 * PowerShell's approved verbs (`Get-Verb`), the closed set every cmdlet name
 * draws from. Spelled here rather than shelled out for, because the whole
 * point is to run where there is no PowerShell.
 */
const APPROVED_VERBS = new Set(
  (
    'Add Clear Close Copy Enter Exit Find Format Get Hide Join Lock Move New Open ' +
    'Optimize Pop Push Redo Remove Rename Reset Resize Search Select Set Show Skip ' +
    'Split Step Switch Undo Unlock Watch Backup Checkpoint Compare Compress Convert ' +
    'ConvertFrom ConvertTo Dismount Edit Expand Export Group Import Initialize Limit ' +
    'Merge Mount Out Publish Restore Save Sync Unpublish Update Debug Measure Ping ' +
    'Repair Resolve Test Trace Connect Disconnect Read Receive Send Write Block Grant ' +
    'Protect Revoke Unblock Unprotect Use Approve Assert Complete Confirm Deny ' +
    'Disable Enable Install Invoke Register Request Restart Resume Start Stop Submit ' +
    'Suspend Uninstall Unregister Wait Deploy ' +
    // Grandfathered built-ins: shipped cmdlets older than the verb list.
    'ForEach Where Sort Tee'
  ).split(' '),
);

/**
 * Words this project renames. None is a PowerShell noun, so `Verb-<word>` in
 * call position is always a mangled cmdlet — the shape the Host→Burrow rename
 * left behind in 147 `Write-Host` calls.
 */
const PROJECT_NOUNS = new Set(['Burrow', 'Burrows', 'Relay', 'Relays', 'Dormouse', 'Pocket']);

/**
 * A `Verb-Noun` token in call position: at a statement start, after a pipe, or
 * inside `$( )` / `& `. Anchoring this way keeps ordinary hyphenated prose and
 * `-Parameter` names out of scope — only what PowerShell would try to resolve.
 */
const CALL = /(?:^|[|(&{;]|\$\()\s*([A-Z][A-Za-z]+)-([A-Z][A-Za-z0-9]*)\b/gm;

export function check() {
  const failures = [];
  const text = readRepoFile(INSTALLER);
  const seen = new Set();
  let checked = 0;

  for (const [, verb, noun] of text.matchAll(CALL)) {
    checked += 1;
    const name = `${verb}-${noun}`;
    if (seen.has(name)) continue;
    if (PROJECT_NOUNS.has(noun)) {
      seen.add(name);
      failures.push(
        `${name}: "${noun}" is this project's word, not a PowerShell noun — a rename ate the cmdlet name`,
      );
      continue;
    }
    if (APPROVED_VERBS.has(verb)) continue;
    seen.add(name);
    failures.push(
      `${name}: "${verb}" is not one of PowerShell's approved verbs, so nothing will resolve this call`,
    );
  }

  return { failures, checked };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, checked } = check();
  if (failures.length > 0) {
    console.error(`ps1-cmdlet-lint: ${INSTALLER} calls something PowerShell cannot resolve\n`);
    for (const failure of failures) console.error(`  ${failure}\n`);
    console.error(
      'A cmdlet name is `ApprovedVerb-Noun`. If a rename rewrote one, restore it; if\n' +
        'this is a new local function, name it with a verb from `Get-Verb`.',
    );
    process.exit(1);
  }
  console.log(`ps1-cmdlet-lint: OK (${checked} calls checked)`);
}

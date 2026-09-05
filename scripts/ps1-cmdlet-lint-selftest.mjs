#!/usr/bin/env node
/**
 * Proves `scripts/ps1-cmdlet-lint.mjs` load-bearing, the way the other sibling
 * lints do (AGENTS.md: "a rule added without its self-test is not enforced").
 *
 * One planted defect per check, each the real shape: a rename eating the noun
 * half of a cmdlet name, and a rename eating the verb half. The installer is
 * copied, mutated, and restored; the lint must go red on each and green again
 * after.
 */

import { copyFileSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { repoRoot } from './lint-kit.mjs';
import { check, INSTALLER } from './ps1-cmdlet-lint.mjs';

/**
 * One mutation, named by what a reader would have done to cause it.
 *
 * `onlyIn` is what keeps the last two honest. A mutation of a name that also
 * appears at statement start proves nothing about any other anchor — the lint
 * goes red on the statement-position copies alone, which is how the missing
 * `=` hid: `Write-Host` is everywhere, so mutating it stayed red while
 * `Read-Host`, which is only ever `$reply = Read-Host '…'`, was invisible.
 * Where `onlyIn` is set, every occurrence of the name in the installer must
 * match it, so a new call in some other position re-points the case instead of
 * silently retiring it.
 */
const DEFECTS = [
  {
    name: 'a rename rewrites the noun half (`Write-Host` → `Write-Burrow`)',
    mutate: (text) => text.replace(/\bWrite-Host\b/g, 'Write-Burrow'),
  },
  {
    name: 'a rename rewrites the verb half (`Test-Path` → `Check-Path`)',
    mutate: (text) => text.replace(/\bTest-Path\b/g, 'Check-Path'),
  },
  {
    name: 'a rename eats a cmdlet only ever called in assignment position (`Read-Host` → `Read-Burrow`)',
    mutate: (text) => text.replace(/\bRead-Host\b/g, 'Read-Burrow'),
    token: /\bRead-Host\b/g,
    onlyIn: /=\s*Read-Host\b/g,
  },
  {
    // The two `function Invoke-Native {` lines are definitions, not calls, and
    // a lowercase keyword is not a call anchor — so `return` is the only
    // position this name is reachable from.
    name: 'a rename eats a cmdlet only ever called after `return` (`Invoke-Native` → `Invoke-Burrow`)',
    mutate: (text) => text.replace(/\bInvoke-Native\b/g, 'Invoke-Burrow'),
    token: /\bInvoke-Native\b/g,
    onlyIn: /(?:return|function)\s+Invoke-Native\b/g,
  },
];

export function run() {
  const failures = [];
  const path = join(repoRoot, INSTALLER);
  const backup = `${path}.selftest-backup`;
  copyFileSync(path, backup);
  const original = readFileSync(path, 'utf8');

  try {
    if (check().failures.length > 0) {
      failures.push('the installer is already failing the lint, so no mutation proves anything');
      return { failures, checked: 0 };
    }

    for (const defect of DEFECTS) {
      const mutated = defect.mutate(original);
      if (mutated === original) {
        failures.push(`${defect.name}: the mutation changed nothing — it no longer plants a defect`);
        continue;
      }
      if (defect.onlyIn) {
        const all = original.match(defect.token)?.length ?? 0;
        const anchored = original.match(defect.onlyIn)?.length ?? 0;
        if (all !== anchored) {
          failures.push(
            `${defect.name}: ${all - anchored} of ${all} occurrences sit somewhere else now, ` +
              'so this case no longer proves the position it names — re-point it',
          );
          continue;
        }
      }
      writeFileSync(path, mutated);
      if (check().failures.length === 0) {
        failures.push(`${defect.name}: the lint stayed green`);
      }
      writeFileSync(path, original);
    }
  } finally {
    copyFileSync(backup, path);
    rmSync(backup, { force: true });
  }

  return { failures, checked: DEFECTS.length };
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  const { failures, checked } = run();
  if (failures.length > 0) {
    console.error('ps1-cmdlet-lint-selftest: a rule in ps1-cmdlet-lint.mjs is not load-bearing\n');
    for (const failure of failures) console.error(`  ${failure}\n`);
    process.exit(1);
  }
  console.log(`ps1-cmdlet-lint-selftest: OK (${checked} load-bearing checks)`);
}

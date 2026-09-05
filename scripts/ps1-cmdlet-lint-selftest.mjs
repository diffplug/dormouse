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

/** One mutation, named by what a reader would have done to cause it. */
const DEFECTS = [
  {
    name: 'a rename rewrites the noun half (`Write-Host` → `Write-Burrow`)',
    mutate: (text) => text.replace(/\bWrite-Host\b/g, 'Write-Burrow'),
  },
  {
    name: 'a rename rewrites the verb half (`Test-Path` → `Check-Path`)',
    mutate: (text) => text.replace(/\bTest-Path\b/g, 'Check-Path'),
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

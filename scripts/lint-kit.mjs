/**
 * The plumbing `deploy-lint` and `e2e-lint` share with their self-tests.
 *
 * Rules and patterns stay in each lint — this is only the machinery around
 * them, factored out because the self-test contract is the part that must never
 * rot: a backup that is not restored leaves an edited installer or source file
 * in the tree, and two copies of that `finally` is two places to get it wrong.
 */

import { copyFileSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The repo root, resolved from this file's own location rather than by shelling
 * out — the idiom `spec-lint.mjs` and `loopback-lint.mjs` already use, and one
 * that works in a checkout with no `git` on `PATH`.
 */
export const repoRoot = fileURLToPath(new URL('..', import.meta.url));

/**
 * Line endings, normalized to `\n`. Patterns that span two adjacent lines see a
 * `\r` in front of every newline on a `core.autocrlf=true` checkout — which no
 * pattern spells, so every span rule would report a present control as missing.
 * Shared with the self-tests, which match and edit the same text.
 */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Read a repo-relative file, EOL-normalized. */
export function readRepoFile(relative) {
  return normalizeEol(readFileSync(join(repoRoot, relative), 'utf8'));
}

let trackedCache = null;

/**
 * Every tracked file, as repo-relative POSIX paths. Tracked rather than walked,
 * so build output — `server-lib-common/dist/` holds a compiled copy of every
 * security module — cannot make a lint's answer depend on whether someone ran a
 * build.
 *
 * `-z` because a path may contain anything; git would otherwise quote it, and a
 * quoted path is one a lint's filter silently drops — a rule whose scope
 * shrinks without saying so. Memoized: a lint asks once per rule.
 */
export function trackedFiles() {
  trackedCache ??= execFileSync('git', ['ls-files', '-z'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  return trackedCache;
}

/** Run one of the lints in a child, so a thrown rule cannot pass as a failure. */
export function lintFails(script) {
  try {
    execFileSync('node', [join(repoRoot, 'scripts', script)], { stdio: 'pipe' });
    return false;
  } catch {
    return true;
  }
}

/**
 * A self-test run: mutate a file, require the lint to go red, restore the file.
 *
 * Restores on any thrown error. A signal mid-run (Ctrl-C, a cancelled job) is
 * the one gap: it can leave an edited file with a `*.bak` beside it. The
 * backups are gitignored, and `git status` shows the edit.
 */
export function makeSelftest(script, backupSuffix) {
  const weak = [];
  let held = 0;
  return {
    weak,
    get held() {
      return held;
    },
    /** Edit `relative` with `mutate`, run the lint, restore, and record. */
    withMutation(relative, mutate, label) {
      const path = join(repoRoot, relative);
      const existed = existsSync(path);
      const backup = `${path}${backupSuffix}`;
      if (existed) copyFileSync(path, backup);
      try {
        mutate(path);
        if (lintFails(script)) held += 1;
        else weak.push(label);
      } finally {
        if (existed) {
          copyFileSync(backup, path);
          rmSync(backup, { force: true });
        } else {
          rmSync(path, { force: true });
        }
      }
    },
    /** Append `text` to `relative` — the shape every "put it back" case takes. */
    withAppended(relative, text, label) {
      this.withMutation(
        relative,
        (path) => writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text),
        label,
      );
    },
    /** Report and exit. Non-zero if anything stayed green that should have gone red. */
    finish(name, hint) {
      if (weak.length > 0) {
        console.error(`${name}: checks that stayed green when they should have gone red\n`);
        for (const w of weak) console.error(`  ${w}\n`);
        console.error(hint);
        process.exit(1);
      }
      console.log(`${name}: OK (${held} load-bearing checks)`);
    },
  };
}

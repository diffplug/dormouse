/**
 * The plumbing the repo's lints share with their self-tests, and the script
 * tests that execute shipped workflow blocks.
 *
 * Rules and patterns stay in each lint — this is only the machinery around
 * them, and the repository layout two lints must agree on (`SHIPPED_DIRS`), factored out because the self-test contract is the part that must never
 * rot: a self-test runs in a private copy of the tree (`makeSelftest`) and
 * never writes the checkout, so another reader of it never sees a planted
 * line and an interrupted run leaves nothing behind.
 */

import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative } from 'node:path';
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
 */
export function normalizeEol(text) {
  return text.replace(/\r\n/g, '\n');
}

/** Read a repo-relative file, EOL-normalized. */
export function readRepoFile(relative) {
  return normalizeEol(readFileSync(join(repoRoot, relative), 'utf8'));
}

/**
 * The shell body of one workflow step, dedented. Tests run the shipped block
 * rather than a copy, so a step that has been renamed must fail loudly here —
 * silently returning the next step's body, or an empty string, would leave a
 * test passing against nothing. Scoped to the named step for the same reason.
 */
export function workflowRunBlock(workflow, stepName) {
  const step = workflow.indexOf(`      - name: ${stepName}\n`);
  if (step < 0) throw new Error(`missing workflow step: ${stepName}`);
  const next = workflow.indexOf('\n      - ', step + 1);
  const marker = '        run: |\n';
  const start = workflow.indexOf(marker, step);
  if (start < 0 || (next >= 0 && start > next)) throw new Error(`missing run block for workflow step: ${stepName}`);
  const body = [];
  for (const line of workflow.slice(start + marker.length).split('\n')) {
    if (line && !line.startsWith('          ')) break;
    body.push(line.slice(10));
  }
  return body.join('\n');
}

/** A temp directory removed when the test finishes. */
export function tempDir(t, prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** NUL-separated repo-relative paths from `git ls-files` with `args`, in the checkout. */
export function gitPaths(...args) {
  return execFileSync('git', ['ls-files', '-z', ...args], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
}

/** The NUL-separated file list a sandbox's processes read in place of `git ls-files`. */
const TRACKED_LIST_ENV = 'LINT_KIT_TRACKED_FILES';

let trackedCache = null;

/**
 * Every tracked file, as repo-relative POSIX paths. Tracked rather than walked,
 * so build output — `remote-lib-common/dist/` holds a compiled copy of every
 * security module — cannot make a lint's answer depend on whether someone ran a
 * build.
 *
 * `-z` because a path may contain anything; git would otherwise quote it, and a
 * quoted path is one a lint's filter silently drops — a rule whose scope
 * shrinks without saying so. Memoized: a lint asks once per rule. A sandbox is
 * no checkout, so a lint running in one reads the list it was copied from.
 */
export function trackedFiles() {
  trackedCache ??= process.env[TRACKED_LIST_ENV]
    ? readFileSync(process.env[TRACKED_LIST_ENV], 'utf8').split('\0').filter(Boolean)
    : gitPaths();
  return trackedCache;
}

/** The 1-based line of `index` in `text`. */
export function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/**
 * The directories whose code reaches a user's machine or phone. One list, so
 * the outbound (`outbound-lint.mjs`) and inbound (`loopback-lint.mjs` check 4)
 * halves of Settings → Network → Nowhere cannot cover different files.
 */
export const SHIPPED_DIRS = [
  'lib/src/',
  'standalone/src/',
  'standalone/sidecar/',
  'vscode-ext/src/',
  'dor/src/',
  'dor-tools-builtin/src/',
  'dor-tools-builtin/viewer/',
  'dor-lib-common/src/',
  'remote-lib-common/src/',
];

/** The shipped code that runs on the phone, never on the computer the policy governs. */
export const PHONE_DIRS = ['lib/src/remote/pocket-app/', 'lib/src/remote/one-time-app/', 'lib/src/remote/client/'];

const SOURCE_EXT = /\.(?:ts|tsx|mts|cts|js|jsx|mjs|cjs)$/;
/** Tests, stories, and the helpers only they import, by the names this repo gives them. */
const TEST_OR_HELPER =
  /(?:\.test\.|\.spec\.|\.stories\.|(?:^|\/)(?:tests?|stories|__tests__)\/|(?:^|\/)test-[^/]*$|test-utils\.|-test-mock\.|-fixtures\.)/;

/** Whether `rel` is a tracked JavaScript or TypeScript source file that ships: under `SHIPPED_DIRS`, and no test or test helper. */
export function isShippedSource(rel) {
  return SOURCE_EXT.test(rel) && SHIPPED_DIRS.some((dir) => rel.startsWith(dir)) && !TEST_OR_HELPER.test(rel);
}

/** A self-test mutation: append `text` to the file, creating it if absent. */
export const appendText = (text) => (path) =>
  writeFileSync(path, (existsSync(path) ? readFileSync(path, 'utf8') : '') + text);

/**
 * A self-test mutation: replace the first `from` with `to`, throwing when `from`
 * is gone — a fixture whose anchor moved would otherwise pass vacuously.
 */
export const replaceText = (from, to) => (path) => {
  const text = readFileSync(path, 'utf8');
  if (!text.includes(from)) throw new Error(`self-test fixture: ${path} no longer contains ${JSON.stringify(from)}`);
  writeFileSync(path, text.replace(from, () => to));
};

/** Run one of the lints in a child and capture the result. */
function runLint(script) {
  try {
    return {
      ok: true,
      stdout: execFileSync('node', [join(repoRoot, 'scripts', script)], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    };
  }
}

/** Run one of the lints in a child, so a thrown rule cannot pass as a failure. */
function lintFails(script) {
  return !runLint(script).ok;
}

/** Set, to the sandbox's directory, in a self-test running inside one. */
const SANDBOX_ENV = 'LINT_KIT_SANDBOX';
const SANDBOX_PREFIX = 'lint-sandbox-';

/**
 * Remove the sandboxes of self-tests no longer running. A signal is left to
 * kill a self-test as it would anyway, so its sandbox outlives it; the pid in
 * the name says whose it was.
 */
function removeOrphanedSandboxes() {
  for (const name of readdirSync(tmpdir())) {
    if (!name.startsWith(SANDBOX_PREFIX)) continue;
    const pid = Number(name.slice(SANDBOX_PREFIX.length).split('-')[0]);
    if (Number.isInteger(pid) && !isRunning(pid)) rmSync(join(tmpdir(), name), { recursive: true, force: true });
  }
}

function isRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

/**
 * Copy the working tree — every tracked file, and every untracked one git does
 * not ignore, as the checkout has them — into a new temp directory, and write
 * the tracked list beside it for `trackedFiles`.
 */
function makeSandbox() {
  removeOrphanedSandboxes();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${SANDBOX_PREFIX}${process.pid}-`)));
  const root = join(dir, 'repo');
  const files = trackedFiles();
  for (const rel of [...files, ...gitPaths('--others', '--exclude-standard')]) {
    const from = join(repoRoot, rel);
    // Deleted in the working tree, so absent to the lint as well. A link is
    // copied as the file it reaches, so nothing in the copy leads back out.
    const stat = lstatSync(from, { throwIfNoEntry: false });
    if (!stat || stat.isDirectory()) continue;
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    copyFileSync(from, to, constants.COPYFILE_FICLONE);
  }
  const list = join(dir, 'tracked');
  writeFileSync(list, files.join('\0'));
  return { dir, root, list };
}

/**
 * Re-run this self-test from a sandbox copy of the tree and exit with its
 * status. The copy's `repoRoot` is the sandbox, so the self-test, every lint
 * it runs, and every path either resolves are the copy's: nothing it plants
 * reaches the checkout.
 */
function rerunInSandbox() {
  const self = relative(repoRoot, realpathSync(process.argv[1]));
  if (self.startsWith('..') || isAbsolute(self)) throw new Error(`self-test: ${process.argv[1]} is outside ${repoRoot}`);
  const { dir, root, list } = makeSandbox();
  const { status } = spawnSync(process.execPath, [join(root, self), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, [SANDBOX_ENV]: dir, [TRACKED_LIST_ENV]: list },
  });
  rmSync(dir, { recursive: true, force: true });
  process.exit(status ?? 1);
}

/**
 * A self-test run: mutate a file, require the lint to go red, restore the file
 * for the next case. Called from the checkout, it re-runs the whole self-test
 * in a sandbox copy of the tree (`rerunInSandbox`) and never returns.
 *
 * Throws unless the lint passes the unmutated copy first — a copy it already
 * fails would turn every case red for that reason and prove nothing.
 */
export function makeSelftest(script) {
  if (!process.env[SANDBOX_ENV]) rerunInSandbox();
  const weak = [];
  let held = 0;
  const pristine = runLint(script);
  if (!pristine.ok) {
    throw new Error(`self-test: ${script} fails the unmutated sandbox, so no case could prove anything\n${pristine.stdout}${pristine.stderr}`);
  }

  /** Edit `relative` with `mutate`, run the lint, restore, and record. */
  function runMutation(relative, mutate, check, label) {
    const path = join(repoRoot, relative);
    const original = existsSync(path) ? readFileSync(path) : null;
    try {
      mutate(path);
      if (check()) held += 1;
      else weak.push(label);
    } finally {
      if (original === null) rmSync(path, { force: true });
      else writeFileSync(path, original);
    }
  }

  return {
    weak,
    /** Apply any mutation and require the lint to fail. */
    withMutation(relative, mutate, label) {
      runMutation(relative, mutate, () => lintFails(script), label);
    },
    /**
     * Apply any mutation and require the lint to fail *with `expected` in its
     * report*, so a case that goes red for an unrelated reason — a broken
     * fixture, another rule — is not counted as proving this one.
     */
    withMutationReporting(relative, mutate, expected, label) {
      runMutation(
        relative,
        mutate,
        () => {
          const result = runLint(script);
          return !result.ok && result.stderr.includes(expected);
        },
        label,
      );
    },
    /** Append `text` to `relative` — the shape every "put it back" case takes. */
    withAppended(relative, text, label) {
      runMutation(
        relative,
        appendText(text),
        () => lintFails(script),
        label,
      );
    },
    /** Append `text`, require the lint to pass, and find `expected` in its output. */
    withAppendedOutput(relative, text, expected, label) {
      runMutation(
        relative,
        appendText(text),
        () => {
          const result = runLint(script);
          return result.ok && result.stdout.includes(expected);
        },
        label,
      );
    },
    /**
     * Require a fixture for every `{ label: '…' }` the lint at `lint` declares:
     * a pattern nothing exercises is a claim, not a check. Read as text because
     * the lints run at module scope and exit, so none can be imported.
     */
    requireFixtures(lint, fixtureLabels, noun) {
      const declared = [...readFileSync(join(repoRoot, lint), 'utf8').matchAll(/\{\s*label: '([^']+)'/g)].map((m) => m[1]);
      if (declared.length === 0) weak.push(`no ${noun}s found in ${lint}\n      the table has moved, so this self-test no longer checks its coverage`);
      for (const label of declared) {
        if (!fixtureLabels.includes(label)) weak.push(`${label}\n      ${lint} declares this ${noun} and no fixture here exercises it`);
      }
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

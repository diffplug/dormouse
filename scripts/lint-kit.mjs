/**
 * The plumbing the repo's lints share with their self-tests, and the script
 * tests that execute shipped workflow blocks.
 *
 * Rules and patterns stay in each lint — this is only the machinery around
 * them, and the repository layout two lints must agree on (`SHIPPED_DIRS`), factored out because the self-test contract is the part that must never
 * rot: a self-test plants each violation in a private copy of the tree
 * (`makeSandbox`) and never writes the repository, so another reader of the
 * checkout never sees a planted line and an interrupted run leaves nothing
 * behind.
 */

import fs, {
  constants,
  copyFileSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
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

let trackedCache = null;

/** Names the NUL-separated file list a lint in a sandbox reads in place of `git ls-files`. */
const TRACKED_LIST_ENV = 'LINT_KIT_TRACKED_FILES';

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
  const list = process.env[TRACKED_LIST_ENV];
  trackedCache ??= (
    list
      ? readFileSync(list, 'utf8')
      : execFileSync('git', ['ls-files', '-z'], {
          cwd: repoRoot,
          encoding: 'utf8',
          maxBuffer: 64 * 1024 * 1024,
        })
  )
    .split('\0')
    .filter(Boolean);
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

/** Run one of the lints in a child — in `sandbox` when given — and capture the result. */
export function runLint(script, sandbox) {
  try {
    return {
      ok: true,
      status: 0,
      stdout: execFileSync('node', [join(sandbox?.root ?? repoRoot, 'scripts', script)], {
        encoding: 'utf8',
        env: sandbox?.env,
        stdio: ['ignore', 'pipe', 'pipe'],
      }),
    };
  } catch (error) {
    return {
      ok: false,
      status: error?.status ?? null,
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
    };
  }
}

/** Whether `path` resolves to `dir` or below it. */
function isWithin(dir, path) {
  const rel = relative(dir, resolve(path));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The `node:fs` calls that write, and which of their arguments is a path they
 * write: a self-test uses only the synchronous API.
 */
const FS_WRITES = {
  appendFileSync: [0],
  chmodSync: [0],
  copyFileSync: [1],
  cpSync: [1],
  linkSync: [1],
  mkdirSync: [0],
  renameSync: [0, 1],
  rmSync: [0],
  rmdirSync: [0],
  symlinkSync: [1],
  truncateSync: [0],
  unlinkSync: [0],
  writeFileSync: [0],
};

let guarded = false;

/**
 * Make every write this process makes through `node:fs` into the repository
 * throw, so a self-test that reaches past its sandbox fails rather than
 * planting a violation where another reader can see it. Applied to the module
 * itself, which `syncBuiltinESMExports` carries to every named import.
 */
function refuseRepoWrites(sandboxDir) {
  if (guarded) return;
  guarded = true;
  for (const [name, positions] of Object.entries(FS_WRITES)) {
    const original = fs[name];
    fs[name] = function guardedWrite(...args) {
      for (const i of positions) {
        const target = args[i] instanceof URL ? fileURLToPath(args[i]) : args[i];
        if (typeof target === 'string' && isWithin(repoRoot, target) && !isWithin(sandboxDir, target)) {
          throw new Error(`self-test: refused ${name} inside the repository (${target}); plant it in the sandbox`);
        }
      }
      return original.apply(this, args);
    };
  }
  syncBuiltinESMExports();
}

const SANDBOX_PREFIX = 'lint-sandbox-';

/**
 * Remove the sandboxes of self-tests no longer running. A signal is left to
 * kill the process as it would anyway — a handler would wait for the event
 * loop, which a self-test's synchronous run never yields to — so its sandbox
 * outlives it.
 */
function removeOrphanedSandboxes() {
  for (const name of readdirSync(tmpdir())) {
    const pid = Number(name.slice(SANDBOX_PREFIX.length).split('-')[0]);
    if (!name.startsWith(SANDBOX_PREFIX) || !Number.isInteger(pid) || pid <= 0 || isRunning(pid)) continue;
    rmSync(join(tmpdir(), name), { recursive: true, force: true });
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
 * A private copy of the working tree, for a self-test to plant violations in:
 * every tracked file, and every untracked one git does not ignore, as the
 * checkout has them. A lint run in it (`runLint(script, sandbox)`) resolves
 * its root to the copy and reads the tracked list it was copied from, so its
 * answer is the one it gives the checkout. Removed when the process exits;
 * one a signal killed is removed by the next self-test to start, found by the
 * pid in its name.
 */
export function makeSandbox() {
  removeOrphanedSandboxes();
  const dir = realpathSync(mkdtempSync(join(tmpdir(), `${SANDBOX_PREFIX}${process.pid}-`)));
  const root = join(dir, 'repo');
  const files = trackedFiles();
  const untracked = execFileSync('git', ['ls-files', '-z', '--others', '--exclude-standard'], {
    cwd: repoRoot,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
    .split('\0')
    .filter(Boolean);
  for (const rel of [...files, ...untracked]) {
    const from = join(repoRoot, rel);
    const stat = lstatSync(from, { throwIfNoEntry: false });
    // Deleted in the working tree, so absent to the lint as well.
    if (!stat || stat.isDirectory()) continue;
    const to = join(root, rel);
    mkdirSync(dirname(to), { recursive: true });
    const link = stat.isSymbolicLink() ? readlinkSync(from) : null;
    // A link that stays inside the copy is kept; any other is copied as the
    // file it reaches, so nothing in the sandbox writes through to the checkout.
    if (link !== null && !isAbsolute(link) && isWithin(root, join(dirname(to), link))) symlinkSync(link, to);
    else copyFileSync(from, to, constants.COPYFILE_FICLONE);
  }
  const list = join(dir, 'tracked');
  writeFileSync(list, files.join('\0'));
  process.once('exit', () => rmSync(dir, { recursive: true, force: true }));
  return { dir, root, env: { ...process.env, [TRACKED_LIST_ENV]: list } };
}

/**
 * A self-test run: mutate a file in a sandbox, require the lint to go red
 * there, restore the file for the next case. Nothing touches the repository:
 * every write this process makes into it throws.
 *
 * Throws unless the lint passes the pristine sandbox first — a copy it already
 * fails would turn every case red for that reason and prove nothing.
 */
export function makeSelftest(script) {
  const sandbox = makeSandbox();
  refuseRepoWrites(sandbox.dir);
  const weak = [];
  let held = 0;
  const result = () => runLint(script, sandbox);
  const fails = () => !result().ok;
  const pristine = result();
  if (!pristine.ok) {
    throw new Error(`self-test: ${script} fails the unmutated sandbox, so no case could prove anything\n${pristine.stdout}${pristine.stderr}`);
  }

  /** Edit `relative` in the sandbox with `mutate`, run the lint, restore, and record. */
  function runMutation(relative, mutate, check, label) {
    const path = join(sandbox.root, relative);
    if (!isWithin(sandbox.root, path)) throw new Error(`self-test: ${relative} is outside the sandbox`);
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
    /** The sandbox's root, for a case that edits it directly and restores it itself. */
    root: sandbox.root,
    /** Run the lint in the sandbox. */
    run: result,
    /** Apply any mutation and require the lint to fail. */
    withMutation(relative, mutate, label) {
      runMutation(relative, mutate, fails, label);
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
          const { ok, stderr } = result();
          return !ok && stderr.includes(expected);
        },
        label,
      );
    },
    /** Append `text` to `relative` — the shape every "put it back" case takes. */
    withAppended(relative, text, label) {
      runMutation(
        relative,
        appendText(text),
        fails,
        label,
      );
    },
    /** Append `text`, require the lint to pass, and find `expected` in its output. */
    withAppendedOutput(relative, text, expected, label) {
      runMutation(
        relative,
        appendText(text),
        () => {
          const { ok, stdout } = result();
          return ok && stdout.includes(expected);
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

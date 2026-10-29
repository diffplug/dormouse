/**
 * What repository holds a directory, for Workspace auto-naming
 * (`docs/specs/layout.md` → "Workspace names"). Bundled into the standalone
 * sidecar as `git-info.cjs`.
 *
 * `localGitRepository` finds the repository, `HEAD` is read directly, and only
 * `config --get` runs: nothing reads the index, and `runGit` disables
 * `core.fsmonitor` regardless. A repository's `.git/config` is still read, the
 * risk `git-upstream.ts` already accepts.
 */
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { localGitRepository } from 'dor-lib-common';
import type { GitDirInfo, GitInfoResult } from '../lib/platform/git-types';
import { settleAllWithin } from '../lib/settle-within';
import { runGit } from './git-cli';
import { canonicalLocalDirectory, resolveBinaryPath } from './local-directory';

// The sidecar's `pty-core` validates a context directory with the same
// resolver, and resolves a requested shell's bare name with `resolveBinaryPath`;
// it reaches both through this bundle.
export { canonicalLocalDirectory, resolveBinaryPath };

/** Lookups still running at this deadline (a hung network mount) are left out
 *  of the answer, for the caller to ask again. */
const LOOKUP_TIMEOUT_MS = 3000;
/** A lookup that did not answer under the deadline. Distinct from `null`,
 *  which is a real "no repository" answer. */
const UNANSWERED = Symbol('unanswered');
/** Paths answered per request; the rest are left out of the answer, for the
 *  caller to ask again. */
const MAX_PATHS = 64;

/**
 * The repository name a remote URL ends in: `git@github.com:diffplug/dormouse.git`
 * and `https://github.com/diffplug/dormouse/` both give `dormouse`. Display
 * only — the trust key is `canonicalRemoteUrl`'s job.
 */
export function remoteRepoName(url: string): string | null {
  const last = url.trim().replace(/[/\\]+$/, '').split(/[/\\:]/).pop() ?? '';
  const name = last.replace(/\.git$/, '');
  return name || null;
}

/** The main checkout's folder: the common dir's parent for `.git`, else a bare
 *  repository's own name. Every worktree of one repository shares it. */
function checkoutName(commonDir: string): string {
  const base = basename(commonDir);
  return base === '.git' ? basename(resolve(commonDir, '..')) : base.replace(/\.git$/, '');
}

/** The branch `HEAD` names (`ref: refs/heads/<branch>`), or a detached
 *  commit's full hash, from a git directory `localGitRepository` checked.
 *  Read rather than asked of git: it exists even on an unborn branch, saves a
 *  spawn, and opens no ref. */
export async function readHead(gitDir: string): Promise<{ branch: string } | { detached: string } | null> {
  const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
  if (ref) return { branch: ref[1] };
  return /^[0-9a-f]{7,}$/.test(head) ? { detached: head } : null;
}

export async function lookupGitDir(path: string): Promise<GitDirInfo | null> {
  // A terminal-reported cwd (`docs/specs/security-local.md` → "Terminal
  // context directory actions").
  const dir = await canonicalLocalDirectory(path);
  if (!dir) return null;
  const [repository, remote] = await Promise.all([
    localGitRepository(dir, { index: false }),
    // `runGit` asks `localGitRepository` itself, so this need not wait.
    runGit(dir, ['config', '--get', 'remote.origin.url']),
  ]);
  if (!repository) return null;
  const head = await readHead(repository.gitDir).catch(() => null);
  if (!head) return null;
  const branch = 'branch' in head ? head.branch : head.detached.slice(0, 7);
  const repo = (remote && remoteRepoName(remote)) || checkoutName(repository.commonDir);
  return { repo, branch };
}

export async function gitInfo(paths: unknown): Promise<GitInfoResult> {
  if (!Array.isArray(paths)) return {};
  const wanted = [...new Set(paths.filter((path): path is string => typeof path === 'string'))].slice(0, MAX_PATHS);
  const answers = await settleAllWithin<GitDirInfo | null | typeof UNANSWERED>(
    wanted.map(lookupGitDir), LOOKUP_TIMEOUT_MS, UNANSWERED);
  // A lookup that missed the deadline is unanswered, never "no repository":
  // leaving it out is what makes the caller ask again
  // (`lib/src/lib/platform/git-types.ts`).
  const entries: [string, GitDirInfo | null][] = [];
  wanted.forEach((path, index) => {
    const answer = answers[index];
    if (answer !== UNANSWERED) entries.push([path, answer]);
  });
  return Object.fromEntries(entries);
}

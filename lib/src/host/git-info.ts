/**
 * What repository holds a directory, for Workspace auto-naming
 * (`docs/specs/layout.md` → "Workspace names"). Bundled into the standalone
 * sidecar as `git-info.cjs`.
 *
 * Only `rev-parse` and `config --get` run, and `HEAD` is read directly: nothing
 * reads the index, so a repository's `core.fsmonitor` never executes. A repository's
 * `.git/config` is still read, the risk `git-upstream.ts` already accepts.
 */
import { readFile, realpath, stat } from 'node:fs/promises';
import { basename, isAbsolute, join, resolve } from 'node:path';
import type { GitDirInfo, GitInfoResult } from '../lib/platform/git-types';
import { settleAllWithin } from '../lib/settle-within';
import { runGit } from './git-cli';

/** Lookups still running at this deadline (a hung network mount) answer "no repository". */
const LOOKUP_TIMEOUT_MS = 3000;
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

/** The canonical path of an existing absolute directory, else null
 *  (`docs/specs/security-local.md` → "Terminal context directory actions"):
 *  these paths originate as terminal-reported cwds. */
async function canonicalDirectory(path: string): Promise<string | null> {
  if (!isAbsolute(path) || path.includes('\0')) return null;
  try {
    const canonical = await realpath(path);
    return (await stat(canonical)).isDirectory() ? canonical : null;
  } catch {
    return null;
  }
}

/** `ref: refs/heads/<branch>`, or a detached commit's full hash. Read rather
 *  than asked of git: it exists even on an unborn branch, and saves a spawn. */
async function headBranch(gitDir: string): Promise<string | null> {
  const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim();
  const ref = /^ref: refs\/heads\/(.+)$/.exec(head);
  if (ref) return ref[1];
  return /^[0-9a-f]{7,}$/.test(head) ? head.slice(0, 7) : null;
}

export async function lookupGitDir(path: string): Promise<GitDirInfo | null> {
  const dir = await canonicalDirectory(path);
  if (!dir) return null;
  const [dirs, remote] = await Promise.all([
    runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir', '--git-dir']),
    // Fails harmlessly outside a repository, so it need not wait for rev-parse.
    runGit(dir, ['config', '--get', 'remote.origin.url']),
  ]);
  const [commonDir, gitDir] = dirs?.split('\n') ?? [];
  if (!commonDir || !gitDir) return null;
  const branch = await headBranch(gitDir).catch(() => null);
  if (!branch) return null;
  const repo = (remote && remoteRepoName(remote)) || checkoutName(commonDir);
  return { repo, branch };
}

export async function gitInfo(paths: unknown): Promise<GitInfoResult> {
  if (!Array.isArray(paths)) return {};
  const wanted = [...new Set(paths.filter((path): path is string => typeof path === 'string'))].slice(0, MAX_PATHS);
  const answers = await settleAllWithin(wanted.map(lookupGitDir), LOOKUP_TIMEOUT_MS, null);
  return Object.fromEntries(wanted.map((path, index) => [path, answers[index]]));
}

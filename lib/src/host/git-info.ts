/**
 * What repository holds a directory, for Workspace auto-naming
 * (`docs/specs/layout.md` → "Workspace names"). Bundled into the standalone
 * sidecar as `git-info.cjs`.
 *
 * Only `rev-parse`, `symbolic-ref`, and `config --get` run: none reads the
 * index, so a repository's `core.fsmonitor` never executes. A repository's
 * `.git/config` is still read, the risk `git-upstream.ts` already accepts.
 */
import { stat } from 'node:fs/promises';
import { basename, isAbsolute, resolve } from 'node:path';
import type { GitDirInfo, GitInfoResult } from '../lib/platform/git-types';
import { runGit } from './git-cli';

/** A lookup slower than this (a hung network mount) answers "no repository". */
const LOOKUP_TIMEOUT_MS = 3000;
/** Paths answered per request; the rest answer "no repository". */
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

async function isDirectory(path: string): Promise<boolean> {
  if (!isAbsolute(path) || path.includes('\0')) return false;
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function lookupGitDir(dir: string): Promise<GitDirInfo | null> {
  if (!(await isDirectory(dir))) return null;
  const commonDir = await runGit(dir, ['rev-parse', '--path-format=absolute', '--git-common-dir']);
  if (!commonDir) return null;
  const [branch, remote] = await Promise.all([
    // Works on an unborn branch, where `rev-parse HEAD` has nothing to name.
    runGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD'])
      .then(async (name) => name ?? (await runGit(dir, ['rev-parse', '--short', 'HEAD']))),
    runGit(dir, ['config', '--get', 'remote.origin.url']),
  ]);
  if (!branch) return null;
  const repo = (remote && remoteRepoName(remote)) || checkoutName(commonDir);
  return { repo, branch };
}

function withTimeout<T>(work: Promise<T>, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<T>((settle) => { timer = setTimeout(() => settle(fallback), LOOKUP_TIMEOUT_MS); });
  return Promise.race([work, timeout]).finally(() => clearTimeout(timer));
}

export async function gitInfo(paths: unknown): Promise<GitInfoResult> {
  const result: GitInfoResult = {};
  if (!Array.isArray(paths)) return result;
  const wanted = [...new Set(paths.filter((path): path is string => typeof path === 'string'))];
  await Promise.all(wanted.map(async (path, index) => {
    result[path] = index < MAX_PATHS ? await withTimeout(lookupGitDir(path).catch(() => null), null) : null;
  }));
  return result;
}

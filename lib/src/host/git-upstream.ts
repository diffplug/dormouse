/**
 * Resolve a project directory's upstream remote URL, for the tool trust key
 * (`docs/specs/dor-tool.md` -> Trust, which records the unverifiability of a
 * `.git/config`-sourced answer as an accepted risk).
 *
 * Every failure — no git, not a repo, no upstream, no remote, unparseable URL —
 * returns `null`, which leaves the caller offering only a folder grant. Failing
 * closed costs one extra approval; guessing would mint a key for the wrong repo.
 */
import { localGitRepository } from 'dor-lib-common';
import { runGit as git } from './git-cli';
import { readHead } from './git-info';
import { canonicalRemoteUrl } from './git-remote-url';

/**
 * The remote the checked-out branch tracks (`branch.<name>.remote`), or null
 * on a detached HEAD, a branch with no upstream, or one tracking a local
 * branch (`.`). Read from `HEAD` and config, never by resolving
 * `@{upstream}`, which opens the remote-tracking ref.
 */
async function trackedRemote(dir: string, gitDir: string): Promise<string | null> {
  const head = await readHead(gitDir).catch(() => null);
  if (!head || !('branch' in head)) return null;
  const remote = await git(dir, ['config', '--get', `branch.${head.branch}.remote`]);
  return remote && remote !== '.' ? remote : null;
}

/**
 * The canonical upstream URL for `dir`, or null.
 *
 * Prefers the branch's own upstream over `origin` so a PR branch tracking a
 * contributor's fork resolves to the fork rather than to the repo you trusted.
 * That is a useful heuristic, not a boundary: a cross-repo PR fetched into
 * `origin` with a pull refspec still resolves to `origin`.
 */
export async function resolveUpstreamUrl(dir: string): Promise<string | null> {
  const repository = await localGitRepository(dir);
  if (!repository) return null;
  const remote = (await trackedRemote(dir, repository.gitDir)) ?? 'origin';
  const url = await git(dir, ['remote', 'get-url', remote]);
  return url ? canonicalRemoteUrl(url) : null;
}

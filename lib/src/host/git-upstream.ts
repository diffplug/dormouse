/**
 * Resolve a project directory's upstream remote URL, for the tool trust key
 * (`docs/specs/dor-tool.md` -> Trust, which records the unverifiability of a
 * `.git/config`-sourced answer as an accepted risk).
 *
 * Every failure — no git, not a repo, no upstream, no remote, unparseable URL —
 * returns `null`, which leaves the caller offering only a folder grant. Failing
 * closed costs one extra approval; guessing would mint a key for the wrong repo.
 */
import { spawnAndCapture } from 'dor-lib-common';
import { canonicalRemoteUrl } from './git-remote-url';

/** The directory travels in argv, not a `cwd` option (`docs/specs/dor-cli.md`
 *  -> the `spawnAndCapture` rules). `dir` is the host-resolved project root,
 *  never a raw string off the wire. */
async function git(dir: string, args: string[]): Promise<string | null> {
  const result = await spawnAndCapture('git', ['-C', dir, ...args]);
  if (!result.ok || result.exitCode !== 0) return null;
  const out = result.stdout.trim();
  return out || null;
}

/**
 * The remote name the current branch tracks (`origin` from `origin/main`), or
 * null on a detached HEAD or a branch with no upstream.
 */
async function trackedRemote(dir: string): Promise<string | null> {
  const upstream = await git(dir, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{upstream}']);
  if (!upstream) return null;
  // `origin/main` -> `origin`. A remote name cannot contain `/`, so the first
  // segment is the remote and everything after is the branch, which may itself
  // contain slashes (`origin/feature/x`).
  const slash = upstream.indexOf('/');
  return slash > 0 ? upstream.slice(0, slash) : null;
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
  const remote = (await trackedRemote(dir)) ?? 'origin';
  const url = await git(dir, ['remote', 'get-url', remote]);
  return url ? canonicalRemoteUrl(url) : null;
}

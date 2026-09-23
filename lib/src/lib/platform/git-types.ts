/**
 * The `gitInfo` wire shapes: what a host reports about the repository holding
 * a directory, for Workspace auto-naming (`docs/specs/layout.md` → "Workspace
 * names").
 */

export interface GitDirInfo {
  /** origin's repository name (`diffplug/dormouse` → `dormouse`), else the
   *  basename of the main checkout. */
  repo: string;
  /** The checked-out branch, or a short commit hash on a detached HEAD. */
  branch: string;
}

/** Keyed by the requested path; `null` for a path in no repository, one that
 *  does not exist, or one git could not answer for in time. A host may leave a
 *  path out of the answer — past its per-request cap, say — and an absent key
 *  means "not answered, ask again", never "no repository". A failure rejects;
 *  it never answers with a partial or empty map. */
export type GitInfoResult = Record<string, GitDirInfo | null>;

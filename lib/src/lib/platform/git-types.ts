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

/** Keyed by the requested path; `null` for a path in no repository or one that
 *  does not exist. A host leaves a path out of the answer when it did not get
 *  one — past its per-request cap or its deadline — and an absent key
 *  means "not answered, ask again", never "no repository". A failure rejects;
 *  it never answers with a partial or empty map. */
export type GitInfoResult = Record<string, GitDirInfo | null>;

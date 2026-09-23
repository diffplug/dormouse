import type { GitDirInfo } from './platform/git-types';
import { cwdDisplay, cwdIdentity, type CwdState } from './terminal-state';

/** One member terminal's say in its Workspace's name, in member order. */
export interface AutoNameVote {
  cwd: CwdState;
  /** The repository holding `cwd`, or null outside one (and for every remote cwd). */
  git: GitDirInfo | null;
}

export function gitAutoName(git: GitDirInfo): string {
  return `${git.repo} @ ${git.branch}`;
}

/**
 * The name a Workspace's terminals give it (`docs/specs/layout.md` → "Workspace
 * names"), or null when no terminal has reported a directory, which keeps the
 * current name.
 *
 * Any vote inside a repository makes it `repo @ branch`, outvoting every
 * directory outside one; otherwise it is the most common directory, counted by
 * identity so two unrelated `src/` folders never pool. A tie keeps `incumbent`
 * when it is among the tied names, else goes to the earliest member's.
 */
export function deriveWorkspaceAutoName(votes: readonly AutoNameVote[], incumbent: string): string | null {
  const gitVotes = votes.filter((vote) => vote.git !== null);
  const counted = gitVotes.length > 0
    ? gitVotes.map((vote) => ({ key: gitAutoName(vote.git!), label: gitAutoName(vote.git!) }))
    : votes.map((vote) => ({ key: cwdIdentity(vote.cwd), label: cwdDisplay(vote.cwd, { style: 'basename' }) }));
  if (counted.length === 0) return null;

  // Map insertion order is first-appearance order, which is the member order tie-break.
  const tallies = new Map<string, { label: string; count: number }>();
  for (const { key, label } of counted) {
    const tally = tallies.get(key);
    if (tally) tally.count += 1;
    else tallies.set(key, { label, count: 1 });
  }
  const best = Math.max(...[...tallies.values()].map((tally) => tally.count));
  const leaders = [...tallies.values()].filter((tally) => tally.count === best);
  return leaders.find((tally) => tally.label === incumbent)?.label ?? leaders[0].label;
}

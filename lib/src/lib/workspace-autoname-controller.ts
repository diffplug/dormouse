import type { GitDirInfo, GitInfoResult } from './platform/git-types';
import { getTerminalPaneStateSnapshot, subscribeToTerminalPaneState } from './terminal-state-store';
import { cwdIdentity, effectiveCwd, type TerminalPaneState } from './terminal-state';
import { deriveWorkspaceAutoName, type AutoNameVote } from './workspace-autoname';
import { getWorkspacesSnapshot, setAutoWorkspaceName, subscribeToWorkspaces } from './workspace-store';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from './workspace-surfaces';

export type GitInfoQuery = (paths: string[]) => Promise<GitInfoResult>;

/** Names are recomputed at most this often. */
const RECOMPUTE_DELAY_MS = 100;
/** How long a failed lookup names by directory before it is asked again. */
const FAILED_RETRY_MS = 30_000;
/** Directories remembered before the cache starts over. */
const CACHE_LIMIT = 1000;

interface CachedGit {
  info: GitDirInfo | null;
  /** The newest command finish this answer covers: a later one may have
   *  switched branch without moving the cwd, so it asks again. */
  asOf: number;
  /** Set on a failed lookup: asked again from this time, whatever `asOf` says. */
  retryAt?: number;
}

/**
 * Keep every auto-named Workspace named after its terminals
 * (`docs/specs/layout.md` → "Workspace names"). Window-wide: it reads the
 * membership each Wall publishes, so hidden Workspaces stay current too.
 * `gitInfo` is absent on a host with no local filesystem, and every directory
 * then counts as outside a repository.
 */
export function installWorkspaceAutoNaming(
  gitInfo: GitInfoQuery | undefined,
  homePath?: Promise<string | undefined>,
): () => void {
  let home: string | undefined;
  const cache = new Map<string, CachedGit>();
  const inflight = new Set<string>();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = () => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      recompute();
    }, RECOMPUTE_DELAY_MS);
  };

  const requestGit = (wanted: Map<string, number>) => {
    const paths = [...wanted.keys()].filter((path) => !inflight.has(path));
    if (!gitInfo || paths.length === 0) return;
    for (const path of paths) inflight.add(path);
    // A path the host left out (past its per-request cap) stays uncached, so
    // the next pass asks again. A failed request names by directory until
    // `retryAt`, so it neither loops nor sticks.
    const settle = (result: GitInfoResult, failed: boolean) => {
      if (cache.size > CACHE_LIMIT) cache.clear();
      const retryAt = failed ? Date.now() + FAILED_RETRY_MS : undefined;
      for (const path of paths) {
        inflight.delete(path);
        const asOf = wanted.get(path)!;
        if (failed) cache.set(path, { info: null, asOf, retryAt });
        else if (path in result) cache.set(path, { info: result[path], asOf });
      }
      if (failed && retryTimer === null) {
        retryTimer = setTimeout(() => { retryTimer = null; schedule(); }, FAILED_RETRY_MS);
      }
      schedule();
    };
    gitInfo(paths).then((result) => settle(result, false), (error: unknown) => {
      console.warn('[workspace-autoname] git lookup failed; naming by directory', error);
      settle({}, true);
    });
  };

  const recompute = () => {
    if (disposed) return;
    const membership = getWorkspaceSurfacesSnapshot();
    const panes = getTerminalPaneStateSnapshot();
    const wanted = new Map<string, number>();
    for (const workspace of getWorkspacesSnapshot().workspaces) {
      if (!workspace.nameIsAuto) continue;
      const votes: AutoNameVote[] = [];
      let waiting = false;
      for (const id of membership.get(workspace.id) ?? []) {
        const pane = panes.get(id);
        const cwd = pane && effectiveCwd(pane);
        if (!pane || !cwd) continue;
        // A remote cwd names a path on another machine; git here cannot see it.
        if (cwd.isRemote || !gitInfo) {
          votes.push({ cwd, git: null });
          continue;
        }
        const asOf = pane.lastCommand?.finishedAt ?? 0;
        const cached = cache.get(cwd.path);
        const stale = !cached || cached.asOf < asOf || (cached.retryAt !== undefined && Date.now() >= cached.retryAt);
        if (stale) wanted.set(cwd.path, Math.max(asOf, wanted.get(cwd.path) ?? 0));
        // Unanswered: hold the current name rather than flash the folder name first.
        if (!cached) waiting = true;
        else votes.push({ cwd, git: cached.info });
      }
      if (waiting) continue;
      const name = deriveWorkspaceAutoName(votes, workspace.name, home);
      if (name !== null) setAutoWorkspaceName(workspace.id, name);
    }
    requestGit(wanted);
  };

  // A pane's title and activity churn far more often than anything a name
  // reads, so only a change to its directory or last command finish wakes it.
  const inputs = new Map<string, string>();
  const onPaneChange = (changedId?: string) => {
    if (changedId === undefined) return schedule();
    const pane = getTerminalPaneStateSnapshot().get(changedId);
    const input = pane ? nameInputs(pane) : '';
    if (inputs.get(changedId) === input) return;
    if (pane) inputs.set(changedId, input);
    else inputs.delete(changedId);
    schedule();
  };

  const unsubscribes = [
    subscribeToWorkspaces(schedule),
    subscribeToWorkspaceSurfaces(schedule),
    subscribeToTerminalPaneState(onPaneChange),
  ];
  void homePath?.then((path) => { home = path || undefined; schedule(); }, () => {});
  schedule();
  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    if (retryTimer !== null) clearTimeout(retryTimer);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

/** Everything about a pane its Workspace's name depends on. */
function nameInputs(pane: TerminalPaneState): string {
  const cwd = effectiveCwd(pane);
  return `${cwd ? cwdIdentity(cwd) : ''}\n${pane.lastCommand?.finishedAt ?? ''}`;
}

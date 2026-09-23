import type { GitDirInfo, GitInfoResult } from './platform/git-types';
import { getTerminalPaneStateSnapshot, subscribeToTerminalPaneState } from './terminal-state-store';
import { deriveWorkspaceAutoName, type AutoNameVote } from './workspace-autoname';
import { getWorkspacesSnapshot, setAutoWorkspaceName, subscribeToWorkspaces } from './workspace-store';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from './workspace-surfaces';

export type GitInfoQuery = (paths: string[]) => Promise<GitInfoResult>;

/** Output arrives a chunk at a time and every chunk wakes the terminal store;
 *  names are recomputed at most this often. */
const RECOMPUTE_DELAY_MS = 100;
/** Directories remembered before the cache starts over. */
const CACHE_LIMIT = 1000;

interface CachedGit {
  info: GitDirInfo | null;
  /** The newest command finish this answer covers: a later one may have
   *  switched branch without moving the cwd, so it asks again. */
  asOf: number;
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
  let timer: ReturnType<typeof setTimeout> | null = null;
  let disposed = false;

  const schedule = () => {
    if (timer !== null || disposed) return;
    timer = setTimeout(() => {
      timer = null;
      recompute();
    }, RECOMPUTE_DELAY_MS);
  };

  const fetch = (wanted: Map<string, number>) => {
    const paths = [...wanted.keys()].filter((path) => !inflight.has(path));
    if (!gitInfo || paths.length === 0) return;
    for (const path of paths) inflight.add(path);
    const settle = (result: GitInfoResult) => {
      if (cache.size > CACHE_LIMIT) cache.clear();
      for (const path of paths) {
        inflight.delete(path);
        cache.set(path, { info: result[path] ?? null, asOf: wanted.get(path)! });
      }
      schedule();
    };
    gitInfo(paths).then(settle, (error: unknown) => {
      console.warn('[workspace-autoname] git lookup failed; naming by directory', error);
      settle({});
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
        const cwd = pane?.currentCommand?.cwdAtStart ?? pane?.cwd;
        if (!pane || !cwd) continue;
        // A remote cwd names a path on another machine; git here cannot see it.
        if (cwd.isRemote || !gitInfo) {
          votes.push({ cwd, git: null });
          continue;
        }
        const asOf = pane.lastCommand?.finishedAt ?? 0;
        const cached = cache.get(cwd.path);
        if (!cached || cached.asOf < asOf) wanted.set(cwd.path, Math.max(asOf, wanted.get(cwd.path) ?? 0));
        // Unanswered: hold the current name rather than flash the folder name first.
        if (!cached) waiting = true;
        else votes.push({ cwd, git: cached.info });
      }
      if (waiting) continue;
      const name = deriveWorkspaceAutoName(votes, workspace.name, home);
      if (name !== null) setAutoWorkspaceName(workspace.id, name);
    }
    fetch(wanted);
  };

  const unsubscribes = [
    subscribeToWorkspaces(schedule),
    subscribeToWorkspaceSurfaces(schedule),
    subscribeToTerminalPaneState(schedule),
  ];
  void homePath?.then((path) => { home = path || undefined; schedule(); }, () => {});
  schedule();
  return () => {
    disposed = true;
    if (timer !== null) clearTimeout(timer);
    for (const unsubscribe of unsubscribes) unsubscribe();
  };
}

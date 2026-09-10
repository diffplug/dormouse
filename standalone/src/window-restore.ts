/**
 * Rebuild the Window at boot: install its Workspaces, then plan each one's
 * Session off a single view of the host's live PTYs (docs/specs/layout.md →
 * "Session persistence").
 *
 * Reload and relaunch are the same code path with a different live list. On a
 * reload the PTYs are still there and partition by saved pane id, so every
 * Workspace resumes over its own; on a relaunch the list is empty and every
 * Workspace cold-restores into fresh shells at its saved cwds, with nothing
 * replayed because scrollback is never persisted.
 */

import type { PlatformAdapter, PtyInfo } from "dormouse-lib/lib/platform/types";
import { collectLivePtys, LIST_RETRY_MS, resumeOrRestoreFrom, type LivePtys } from "dormouse-lib/lib/reconnect";
import {
  flushWindowSession,
  installWindowSessionWriter,
  seedWindowSession,
} from "dormouse-lib/lib/window-session-aggregator";
import {
  generateWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
  setWorkspaces,
} from "dormouse-lib/lib/workspace-store";
import { DEFAULT_WORKSPACE_NAME, windowPaneIds } from "dormouse-lib/lib/session-types";
import type { PersistedSession, PersistedWindow, WorkspaceId } from "dormouse-lib/lib/session-types";
import { wallBootFromResult, type WallBootPlans } from "dormouse-lib/components/wall/wall-types";

/**
 * How a live PTY that no saved Workspace names is routed. Two kinds reach here:
 * a helper, which belongs wherever its source does, and everything else — a pane
 * created inside the last save's debounce, or one left by a Workspace that is
 * gone — which goes to the active Workspace rather than being stranded with no
 * Wall.
 */
export interface LivePtyRouting {
  /** Extra ids each Workspace claims by name, beyond its saved panes. */
  extra: Map<WorkspaceId, Set<string>>;
  /** Ids the active Workspace adopts (`claimUnowned`). */
  unowned: Set<string>;
}

/**
 * Route the live PTYs no saved Workspace names.
 *
 * A helper PTY is never a persisted pane, so by name it is always unowned. It
 * must still land in the Workspace holding its source: routed anywhere else it
 * misses that plan's slice, is resumed as an ordinary top-level pane, and its id
 * — absent from that Workspace's saved panes — makes the whole saved layout
 * unusable, costing the Workspace its splits, Doors and refs. A helper whose
 * source is itself unowned follows it into the active Workspace.
 */
export function routeUnownedPtys(
  ptys: readonly PtyInfo[],
  saved: PersistedWindow | null,
): LivePtyRouting {
  const ownerByPaneId = new Map<string, WorkspaceId>();
  for (const workspace of saved?.workspaces ?? []) {
    for (const pane of workspace.session.panes) ownerByPaneId.set(pane.id, workspace.id);
  }

  const extra = new Map<WorkspaceId, Set<string>>();
  const unowned = new Set<string>();
  for (const pty of ptys) {
    if (ownerByPaneId.has(pty.id)) continue;
    // Parents are resolved across the WHOLE saved Window, not one Workspace's
    // slice — the point of the routing is that source and helper end up in the
    // same slice afterwards.
    const owner = pty.helper ? ownerByPaneId.get(pty.helper.parentId) : undefined;
    if (owner === undefined) {
      unowned.add(pty.id);
      continue;
    }
    let ids = extra.get(owner);
    if (!ids) extra.set(owner, (ids = new Set()));
    ids.add(pty.id);
  }
  return { extra, unowned };
}

/**
 * Restore the Window, degrading to a fresh one if anything in the restore throws.
 * A blob the store cannot install — a duplicate Workspace id is the one that has
 * bitten — would otherwise take the whole launch down before `render`, leaving a
 * blank app that fails again on every start. The fresh Window overwrites it.
 */
export async function restoreWindowOrFresh(platform: PlatformAdapter): Promise<WallBootPlans> {
  const saved = platform.getWindowState?.() ?? null;
  try {
    return await restoreWindow(platform, saved);
  } catch (err) {
    console.error("[dormouse] Could not restore the persisted Window; starting fresh", err);
  }
  try {
    resetWorkspaces();
    const plans = await restoreWindow(platform, null);
    // Overwrite the blob that could not be restored, so the next launch does not
    // meet it again.
    await flushWindowSession();
    return plans;
  } catch (err) {
    console.error("[dormouse] Could not start a fresh Window either; rendering with no plan", err);
    return {};
  }
}

/**
 * Seed the Window's records and install its Workspaces and writer, before any
 * Wall mounts. Shared with the tear-out boot, whose one Workspace arrives from
 * another Window rather than from disk (`standalone/src/workspace-move.ts`).
 */
export function installWindowPersistence(
  platform: PlatformAdapter,
  saved: PersistedWindow | null,
): void {
  // A Workspace's first save compares against its own record, and a snapshot
  // taken mid-boot must not replace a restored Workspace with a blank one.
  seedWindowSession(saved);
  if (saved) {
    setWorkspaces({
      workspaces: saved.workspaces.map(({ id, name }) => ({ id, name })),
      activeId: saved.activeWorkspaceId,
    });
  } else {
    // A fresh Window mints its first Workspace's id rather than taking the
    // lib's `DEFAULT_WORKSPACE_ID`: every window would otherwise start on the
    // same id, and a second window opened after the first one closed would
    // write a blob whose Workspace id is already live in another window's blob
    // (`docs/specs/standalone.md` → "Persistence"). A bare Wall, which is one
    // Window's whole application, keeps the default id.
    const id = generateWorkspaceId();
    setWorkspaces({ workspaces: [{ id, name: DEFAULT_WORKSPACE_NAME }], activeId: id });
  }
  // After `setWorkspaces`, so installing does not immediately write back what was
  // just read.
  installWindowSessionWriter((snapshot) => platform.saveWindowState?.(snapshot));
}

async function restoreWindow(
  platform: PlatformAdapter,
  saved: PersistedWindow | null,
): Promise<WallBootPlans> {
  installWindowPersistence(platform, saved);

  // Asked twice when the host says nothing at all and this Window has terminal
  // panes to lose: `resumeOrRestoreFrom` reads a timed-out list as "no live
  // PTYs" and cold-restores, which starts a second set of shells over the ones
  // still running (`docs/specs/transport.md` → "Reconnection").
  const hasTerminalPanes = (saved?.workspaces ?? []).some((workspace) =>
    workspace.session.panes.some((pane) => pane.surfaceType !== "browser"));
  const live: LivePtys = await collectLivePtys(platform, {
    ...(hasTerminalPanes ? { retryTimeoutMs: LIST_RETRY_MS } : {}),
  });
  // The fresh Window's id was minted by `installWindowPersistence` above.
  const installed = getWorkspacesSnapshot();
  const restoring: Array<{ id: WorkspaceId; session: PersistedSession | null }> =
    saved?.workspaces ?? [{ id: installed.activeId, session: null }];
  const activeId = saved?.activeWorkspaceId ?? installed.activeId;

  const { extra, unowned } = routeUnownedPtys(live.ptys, saved);

  // The recovery claim is a host round trip started back in `init()`. Await it
  // only when something here can actually cold-restore: a Window whose every
  // saved pane is live resumes over those PTYs and never reads the record.
  const named = windowPaneIds(saved);
  const liveSet = new Set(live.ptys.map((pty) => pty.id));
  if (!named.every((id) => liveSet.has(id))) await platform.recoveryReady;

  const plans: WallBootPlans = {};
  for (const { id, session } of restoring) {
    const result = resumeOrRestoreFrom(platform, live, {
      savedSession: session,
      ptyIds: new Set([
        ...(session?.panes.map((pane) => pane.id) ?? []),
        ...(extra.get(id) ?? []),
      ]),
      ...(id === activeId ? { claimUnowned: unowned } : {}),
    });
    plans[id] = wallBootFromResult(result);
  }
  return plans;
}

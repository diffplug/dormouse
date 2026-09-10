import type { PlatformAdapter } from './platform/types';
import { browserPersistedPane, readPersistedSession, toPersistedAlertState, type PersistedDoor, type PersistedPane, type PersistedSession, type PersistedSurfaceRefs, type PersistedSurfaceType } from './session-types';
import { getActivity, getLivePersistedAlertState, getTerminalPaneState, isUntouched } from './terminal-registry';
import { UNNAMED_PANEL_TITLE } from './terminal-state';

/**
 * Where a save reads its previous record from and where it writes the new one.
 * A Workspace supplies both, so its record is compared against and published
 * beside its own Workspace's rather than the Window's active one
 * (`docs/specs/transport.md` → "Persisted session").
 */
export interface SaveSink {
  /** This Workspace's last persisted record; `getPreviousPaneMap` reads a dead
   *  PTY's retained cwd out of it. */
  previous?: () => PersistedSession | null;
  publish?: (session: PersistedSession) => void;
}

function previousPaneMap(previous: PersistedSession | null): Map<string, PersistedPane> {
  if (!previous || !Array.isArray(previous.panes)) return new Map();
  return new Map(previous.panes.map((pane) => [pane.id, pane]));
}

export interface SavePaneInput {
  id: string;
  title: string;
  surfaceType?: PersistedSurfaceType;
}

/**
 * Build one Workspace's `PersistedSession` from its live panes and Doors. Split
 * out of `saveSession` because a Wall's handle serializes on demand (a Window
 * snapshot, a quit) without writing anything.
 */
export async function buildPersistedSession(
  platform: PlatformAdapter,
  panes: SavePaneInput[],
  doors: PersistedDoor[] = [],
  // The native Lath persisted layout (docs/specs/tiling-engine.md → "Persistence").
  // The only layout Dormouse writes.
  lathLayout?: unknown,
  surfaceRefs?: PersistedSurfaceRefs,
  // The Workspace's next `surface:N` counter, persisted independently of
  // `surfaceRefs` so pruned (killed) entries never cause a number to be reused.
  surfaceRefsNext?: number,
  previous?: PersistedSession | null,
): Promise<PersistedSession> {
  const previousPanes = previousPaneMap(previous ?? null);
  const allPanes = new Map<string, { id: string; title: string; surfaceType: PersistedSurfaceType }>();
  for (const pane of panes) {
    allPanes.set(pane.id, { id: pane.id, title: persistedVisiblePaneTitle(pane.title), surfaceType: pane.surfaceType ?? 'terminal' });
  }
  const persistedDoors = doors.map((door) => ({
    ...door,
    title: persistedDoorTitle(door.id, door.title, door.component),
  }));
  for (const item of persistedDoors) {
    allPanes.set(item.id, { id: item.id, title: item.title, surfaceType: item.component === 'browser' ? 'browser' : 'terminal' });
  }

  const persisted: PersistedPane[] = await Promise.all(
    [...allPanes.values()].map(async (pane) => {
      const previousPane = previousPanes.get(pane.id);
      if (pane.surfaceType === 'browser') {
        // The activity store already holds this surface's TODO; persist it as the
        // alert blob, projected to the persisted fields.
        const activity = getActivity(pane.id);
        return browserPersistedPane(pane, activity.todo ? toPersistedAlertState(activity) : null);
      }

      const liveAlert = getLivePersistedAlertState(pane.id);
      const cwd = await platform.getCwd(pane.id);
      return {
        id: pane.id,
        title: pane.title,
        cwd: cwd ?? previousPane?.cwd ?? null,
        untouched: isUntouched(pane.id),
        alert: liveAlert ?? previousPane?.alert ?? null,
      };
    }),
  );
  return {
    version: 3,
    panes: persisted,
    doors: persistedDoors,
    ...(lathLayout !== undefined ? { lathLayout } : {}),
    ...(surfaceRefs && Object.keys(surfaceRefs).length > 0 ? { surfaceRefs } : {}),
    ...(surfaceRefsNext !== undefined && surfaceRefsNext > 1 ? { surfaceRefsNext } : {}),
  };
}

// Every input read here needs a dirty trigger in use-session-persistence.ts;
// the unconditional flushes + store-level compare only bound the staleness.
export async function saveSession(
  platform: PlatformAdapter,
  panes: SavePaneInput[],
  doors: PersistedDoor[] = [],
  lathLayout?: unknown,
  surfaceRefs?: PersistedSurfaceRefs,
  surfaceRefsNext?: number,
  /** Defaults to the platform's own slot; a Workspace substitutes its own. */
  sink?: SaveSink,
): Promise<void> {
  // Gate the work, not just the write. Building the record costs a `getCwd`
  // round trip per terminal pane — on standalone that lands on a synchronous
  // `lsof` in the sidecar — and a host that persists nothing would spend all of
  // it on every debounced save, every 30s heartbeat, and twice more per quit,
  // only for `saveState` to drop the result.
  if (platform.persistsSession === false) return;
  const previous = sink?.previous ? sink.previous() : readPersistedSession(platform.getState());
  const session = await buildPersistedSession(platform, panes, doors, lathLayout, surfaceRefs, surfaceRefsNext, previous);
  if (sink?.publish) sink.publish(session);
  else platform.saveState(session);
}

function persistedVisiblePaneTitle(title: string): string {
  const trimmed = title.trim();
  return trimmed || UNNAMED_PANEL_TITLE;
}

function persistedDoorTitle(id: string, fallback: string, component: string | undefined): string {
  const userTitle = getTerminalPaneState(id).titleCandidates.user?.title.trim();
  if (userTitle) return userTitle;
  return component && component !== 'terminal' ? persistedVisiblePaneTitle(fallback) : UNNAMED_PANEL_TITLE;
}

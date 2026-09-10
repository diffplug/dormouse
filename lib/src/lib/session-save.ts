import type { PlatformAdapter } from './platform/types';
import { browserPersistedPane, readPersistedSession, toPersistedAlertState, type PersistedDoor, type PersistedPane, type PersistedSession, type PersistedSurfaceRefs, type PersistedSurfaceType } from './session-types';
import { getActivity, getLivePersistedAlertState, getTerminalPaneState, isUntouched } from './terminal-registry';
import { UNNAMED_PANEL_TITLE } from './terminal-state';

/**
 * Where a save reads its previous record from and where it writes the new one.
 * A Workspace supplies both, so its record is compared against and published
 * beside its own Workspace's rather than the Window's active one
 * (`docs/specs/transport.md` → "Persisted session"). No sink at all is the
 * platform slot; a half-supplied one would silently mix the two.
 */
export interface SaveSink {
  /** This Workspace's last persisted record; the previous-pane map reads a dead
   *  PTY's retained cwd out of it. */
  previous: () => PersistedSession | null;
  publish: (session: PersistedSession) => void;
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

/** What one save may skip. See `SessionFlushRequest.probeCwd`. */
export interface SaveOptions {
  /** Re-read each terminal pane's cwd from the host. Defaults to true; `false`
   *  keeps whatever the previous record held. */
  probeCwd?: boolean;
}

/**
 * Every terminal pane's cwd, in one host round trip where the adapter can do
 * that. `null` means the caller asked not to probe at all, so each pane keeps
 * its previous value.
 */
async function probeCwds(
  platform: PlatformAdapter,
  ids: string[],
  probe: boolean,
): Promise<Record<string, string | null> | null> {
  if (!probe || ids.length === 0) return null;
  if (platform.getCwds) return platform.getCwds(ids);
  const answers = await Promise.all(ids.map((id) => platform.getCwd(id)));
  const cwds: Record<string, string | null> = {};
  ids.forEach((id, index) => { cwds[id] = answers[index]; });
  return cwds;
}

/**
 * Build one Workspace's `PersistedSession` from its live panes and Doors.
 *
 * Exported for the transfer verb, which needs the record WITHOUT publishing it:
 * the Workspace is leaving this Window, so its record belongs in the payload
 * rather than in this Window's aggregator
 * (`releaseWorkspaceForTransfer` in `lib/src/components/wall/workspace-transfer.ts`).
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
  options: SaveOptions = {},
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

  // One probe for the whole set, before the per-pane build: a terminal pane's cwd
  // is the only field here that costs a host round trip.
  const cwds = await probeCwds(
    platform,
    [...allPanes.values()].filter((pane) => pane.surfaceType !== 'browser').map((pane) => pane.id),
    options.probeCwd !== false,
  );

  const persisted: PersistedPane[] = [...allPanes.values()].map((pane) => {
    const previousPane = previousPanes.get(pane.id);
    if (pane.surfaceType === 'browser') {
      // The activity store already holds this surface's TODO; persist it as the
      // alert blob, projected to the persisted fields.
      const activity = getActivity(pane.id);
      return browserPersistedPane(pane, activity.todo ? toPersistedAlertState(activity) : null);
    }

    const liveAlert = getLivePersistedAlertState(pane.id);
    return {
      id: pane.id,
      title: pane.title,
      cwd: cwds?.[pane.id] ?? previousPane?.cwd ?? null,
      untouched: isUntouched(pane.id),
      alert: liveAlert ?? previousPane?.alert ?? null,
    };
  });
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
  options: SaveOptions = {},
): Promise<void> {
  // Gate the work, not just the write. Building the record costs a cwd probe —
  // on standalone a synchronous process scan in the sidecar — and a host that
  // persists nothing would spend it on every debounced save, every 30s
  // heartbeat, and twice more per quit, only for `saveState` to drop the result.
  if (platform.persistsSession === false) return;
  const previous = sink ? sink.previous() : readPersistedSession(platform.getState());
  const session = await buildPersistedSession(platform, panes, doors, lathLayout, surfaceRefs, surfaceRefsNext, previous, options);
  if (sink) sink.publish(session);
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

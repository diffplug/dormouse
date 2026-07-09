import type { PlatformAdapter } from './platform/types';
import { browserPersistedPane, readPersistedSession, type PersistedDoor, type PersistedPane, type PersistedSession, type PersistedSurfaceRefs, type PersistedSurfaceType } from './session-types';
import { detectResumeCommand } from './resume-patterns';
import { trimPersistedScrollback } from './scrollback-trim';
import { getActivity, getLivePersistedAlertState, getTerminalPaneState, isUntouched, resolveTerminalSessionId } from './terminal-registry';
import { UNNAMED_PANEL_TITLE } from './terminal-state';

function getPreviousPaneMap(platform: PlatformAdapter): Map<string, PersistedPane> {
  const saved = readPersistedSession(platform.getState());
  if (!saved || !Array.isArray(saved.panes)) {
    return new Map();
  }
  return new Map(saved.panes.map((pane) => [pane.id, pane]));
}

// Every input read here needs a dirty trigger in use-session-persistence.ts;
// the unconditional flushes + store-level compare only bound the staleness.
export async function saveSession(
  platform: PlatformAdapter,
  panes: Array<{ id: string; title: string; surfaceType?: PersistedSurfaceType }>,
  doors: PersistedDoor[] = [],
  // The native Lath persisted layout (docs/specs/tiling-engine.md → "Persistence").
  // The only layout Dormouse writes.
  lathLayout?: unknown,
  surfaceRefs?: PersistedSurfaceRefs,
  // The Workspace's next `surface:N` counter, persisted independently of
  // `surfaceRefs` so pruned (killed) entries never cause a number to be reused.
  surfaceRefsNext?: number,
): Promise<void> {
  const previousPanes = getPreviousPaneMap(platform);
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
        // alert blob (ActivityState is assignable to PersistedAlertState).
        const activity = getActivity(pane.id);
        return browserPersistedPane(pane, activity.todo ? activity : null);
      }

      const liveAlert = getLivePersistedAlertState(pane.id);
      const sessionId = resolveTerminalSessionId(pane.id);
      const [scrollback, cwd] = await Promise.all([
        platform.getScrollback(sessionId),
        platform.getCwd(sessionId),
      ]);
      // Resume-command patterns live at the tail, so trimming before detection
      // is safe.
      const trimmedScrollback = trimPersistedScrollback(scrollback ?? previousPane?.scrollback ?? null);
      return {
        id: pane.id,
        title: pane.title,
        cwd: cwd ?? previousPane?.cwd ?? null,
        scrollback: trimmedScrollback,
        resumeCommand: trimmedScrollback ? detectResumeCommand(trimmedScrollback) : null,
        untouched: isUntouched(pane.id),
        alert: liveAlert ?? previousPane?.alert ?? null,
      };
    }),
  );
  const session: PersistedSession = {
    version: 3,
    panes: persisted,
    doors: persistedDoors,
    ...(lathLayout !== undefined ? { lathLayout } : {}),
    ...(surfaceRefs && Object.keys(surfaceRefs).length > 0 ? { surfaceRefs } : {}),
    ...(surfaceRefsNext !== undefined && surfaceRefsNext > 1 ? { surfaceRefsNext } : {}),
  };
  platform.saveState(session);
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

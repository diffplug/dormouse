import type { PlatformAdapter } from './platform/types';
import { browserPersistedPane, readPersistedSession, type PersistedDoor, type PersistedPane, type PersistedSession, type PersistedSurfaceRefs, type PersistedSurfaceType, type PersistedToolMetadata } from './session-types';
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
  panes: Array<{ id: string; title: string; surfaceType?: PersistedSurfaceType; params?: Record<string, unknown> }>,
  doors: PersistedDoor[] = [],
  // The native Lath persisted layout (docs/specs/tiling-engine.md → "Persistence").
  // The only layout Dormouse writes.
  lathLayout?: unknown,
  surfaceRefs?: PersistedSurfaceRefs,
  // The Workspace's next `surface:N` counter, persisted independently of
  // `surfaceRefs` so pruned (killed) entries never cause a number to be reused.
  surfaceRefsNext?: number,
): Promise<void> {
  // Gate the work, not just the write. Building the record costs a `getCwd`
  // round trip per terminal pane — on standalone that lands on a synchronous
  // `lsof` in the sidecar — and a host that persists nothing would spend all of
  // it on every debounced save, every 30s heartbeat, and twice more per quit,
  // only for `saveState` to drop the result.
  if (platform.persistsSession === false) return;
  const previousPanes = getPreviousPaneMap(platform);
  const allPanes = new Map<string, { id: string; title: string; surfaceType: PersistedSurfaceType; params?: Record<string, unknown> }>();
  for (const pane of panes) {
    allPanes.set(pane.id, {
      id: pane.id,
      title: persistedVisiblePaneTitle(pane.title),
      surfaceType: pane.surfaceType ?? 'terminal',
      params: pane.params,
    });
  }
  const persistedDoors = doors.map((door) => ({
    ...door,
    title: persistedDoorTitle(door.id, door.title, door.component),
  }));
  for (const item of persistedDoors) {
    // A Door's component is the leaf's kind: a minimized tool must persist as
    // 'tool', or its row round-trips as a plain terminal.
    const doorSurfaceType = item.component === 'browser' || item.component === 'tool'
      ? item.component
      : 'terminal';
    allPanes.set(item.id, { id: item.id, title: item.title, surfaceType: doorSurfaceType, params: item.params });
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
      const cwd = await platform.getCwd(sessionId);
      const terminalPane: PersistedPane = {
        id: pane.id,
        title: pane.title,
        cwd: cwd ?? previousPane?.cwd ?? null,
        untouched: isUntouched(pane.id),
        alert: liveAlert ?? previousPane?.alert ?? null,
      };
      if (pane.surfaceType !== 'tool') return terminalPane;

      const command = toolCommandFromParams(pane.params) ?? previousPane?.command;
      const tool = toolMetadataFromParams(pane.params) ?? previousPane?.tool;
      return {
        ...terminalPane,
        surfaceType: 'tool',
        ...(command ? { command } : {}),
        ...(tool ? { tool } : {}),
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

function toolCommandFromParams(params: Record<string, unknown> | undefined): string | null {
  const command = params?.command;
  return typeof command === 'string' && command.trim() ? command : null;
}

function toolMetadataFromParams(params: Record<string, unknown> | undefined): PersistedToolMetadata | null {
  if (!params) return null;
  const name = typeof params.toolName === 'string' && params.toolName ? params.toolName : undefined;
  const render = params.toolRender === 'ab-screencast' ? 'ab-screencast' : 'iframe';
  const port = params.toolPort === 'auto' ? 'auto' : 'announced';
  const key = Array.isArray(params.toolKey) && params.toolKey.every((part) => typeof part === 'string')
    ? params.toolKey as string[]
    : undefined;
  return { ...(name ? { name } : {}), render, port, ...(key ? { key } : {}) };
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

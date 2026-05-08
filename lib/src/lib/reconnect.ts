import type { PlatformAdapter, PtyInfo } from './platform/types';
import { resumeTerminal } from './terminal-registry';
import { readPersistedSession, type PersistedDoor } from './session-types';
import { restoreSession } from './session-restore';

export interface ReconnectResult {
  paneIds: string[];
  layout?: unknown; // dockview SerializedDockview, only present on cold-start restore
  doors?: PersistedDoor[];
}

/**
 * Resume over live PTYs, or cold-restore from saved session.
 *
 * Priority:
 * 1. Live PTYs (webview was hidden/shown) → resume with replay data
 * 2. Saved session (app restarted) → restore with saved scrollback + cwd
 * 3. Neither → return empty (Wall creates a fresh terminal)
 */
export async function resumeOrRestore(platform: PlatformAdapter): Promise<ReconnectResult> {
  // First, try to resume over live PTYs
  const liveResult = await resumeLiveSessions(platform);
  if (liveResult) return liveResult;

  // No live PTYs — try cold restore
  const restored = await restoreSession(platform);
  if (restored) return restored;

  return { paneIds: [] };
}

function resumeLiveSessions(platform: PlatformAdapter): Promise<ReconnectResult | null> {
  return new Promise<ReconnectResult | null>((resolve) => {
    const replayBuffer = new Map<string, string>();
    let ptyList: PtyInfo[] | null = null;

    const timeout = setTimeout(() => finish(), 500);

    const handleList = (detail: { ptys: PtyInfo[] }) => {
      ptyList = detail.ptys;
      if (ptyList.length === 0) {
        finish();
      }
    };

    const handleReplay = (detail: { id: string; data: string }) => {
      replayBuffer.set(detail.id, detail.data);
      if (ptyList && replayBuffer.size >= ptyList.length) {
        finish();
      }
    };

    let finished = false;
    function finish() {
      if (finished) return;
      finished = true;
      clearTimeout(timeout);
      platform.offPtyList(handleList);
      platform.offPtyReplay(handleReplay);

      if (!ptyList || ptyList.length === 0) {
        resolve(null);
        return;
      }

      const savedState = platform.getState();
      const savedVisibleTitles = getSavedVisiblePaneTitles(savedState, ptyList.map((pty) => pty.id));
      const ids: string[] = [];
      for (const pty of ptyList) {
        const resumeInfo: { alive: boolean; exitCode?: number; title?: string } = {
          alive: pty.alive,
          exitCode: pty.exitCode,
        };
        const savedTitle = savedVisibleTitles.get(pty.id);
        if (savedTitle !== undefined) resumeInfo.title = savedTitle;
        resumeTerminal(pty.id, replayBuffer.get(pty.id) ?? null, resumeInfo);
        ids.push(pty.id);
      }
      // Pull saved visible/doors state so a resume (e.g. after panel
      // close/reopen) restores splits and doors instead of stacking every live
      // PTY into one tab group.
      const savedPlan = getSavedResumePlan(savedState, ids);
      if (savedPlan) {
        resolve(savedPlan);
        return;
      }

      resolve({ paneIds: ids, doors: [] });
    }

    platform.onPtyList(handleList);
    platform.onPtyReplay(handleReplay);
    platform.requestInit();
  });
}

function getSavedVisiblePaneTitles(savedState: unknown, liveIds: string[]): Map<string, string> {
  const saved = readPersistedSession(savedState);
  if (!saved || !Array.isArray(saved.panes)) return new Map();

  const liveSet = new Set(liveIds);
  const doorIds = new Set((saved.doors ?? []).map((item) => item.id));
  const result = new Map<string, string>();
  for (const pane of saved.panes) {
    if (!liveSet.has(pane.id) || doorIds.has(pane.id)) continue;
    result.set(pane.id, pane.title);
  }
  return result;
}

function getSavedResumePlan(savedState: unknown, liveIds: string[]): ReconnectResult | null {
  const saved = readPersistedSession(savedState);
  if (!saved || !Array.isArray(saved.panes)) return null;

  // Reuse persisted visible/doors state only when every live PTY is covered
  // by the saved session. Extra saved panes can be stale, but extra live panes
  // have no reliable saved layout position.
  const liveSet = new Set(liveIds);
  const savedSet = new Set(saved.panes.map((p) => p.id));
  if (!liveIds.every((id) => savedSet.has(id))) return null;

  const doors = (saved.doors ?? []).filter((item) => liveSet.has(item.id));
  const doorIds = new Set(doors.map((item) => item.id));
  const paneIds = saved.panes
    .filter((pane) => liveSet.has(pane.id) && !doorIds.has(pane.id))
    .map((pane) => pane.id);
  const layoutPanelIds = getLayoutPanelIds(saved.layout);
  const layoutMatchesVisiblePanes =
    !!layoutPanelIds &&
    layoutPanelIds.length === paneIds.length &&
    layoutPanelIds.every((id) => paneIds.includes(id));

  return {
    paneIds,
    doors,
    layout: layoutMatchesVisiblePanes ? saved.layout : undefined,
  };
}

function getLayoutPanelIds(layout: unknown): string[] | null {
  if (!layout || typeof layout !== 'object') return null;
  const panels = (layout as { panels?: unknown }).panels;
  if (!panels || typeof panels !== 'object' || Array.isArray(panels)) return null;
  return Object.keys(panels);
}

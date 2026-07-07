import type { PlatformAdapter, PtyInfo } from './platform/types';
import { restoreBrowserSurfaceTodo, resumeTerminal } from './terminal-registry';
import { readPersistedSession, type PersistedDoor } from './session-types';
import { restoreSession } from './session-restore';

export interface ReconnectResult {
  paneIds: string[];
  /** Legacy dockview layout blob from pre-Lath saves; migrated one-way on seed. Only
   *  present on cold-start restore, gated by the same pane-set match as `lathLayout`. */
  layout?: unknown;
  /** Native Lath persisted layout; preferred over `layout` when present. */
  lathLayout?: unknown;
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
      const savedResumeInfo = getSavedPaneResumeInfo(savedState, ptyList.map((pty) => pty.id));
      const ids: string[] = [];
      for (const pty of ptyList) {
        const resumeInfo: { alive: boolean; exitCode?: number; title?: string; untouched?: boolean } = {
          alive: pty.alive,
          exitCode: pty.exitCode,
        };
        const savedInfo = savedResumeInfo.get(pty.id);
        if (savedInfo?.title !== undefined) resumeInfo.title = savedInfo.title;
        if (savedInfo?.untouched) resumeInfo.untouched = true;
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

function getSavedPaneResumeInfo(savedState: unknown, liveIds: string[]): Map<string, { title: string; untouched: boolean }> {
  const saved = readPersistedSession(savedState);
  if (!saved || !Array.isArray(saved.panes)) return new Map();

  const liveSet = new Set(liveIds);
  const result = new Map<string, { title: string; untouched: boolean }>();
  for (const pane of saved.panes) {
    restoreBrowserSurfaceTodo(pane);
    if (!liveSet.has(pane.id)) continue;
    result.set(pane.id, { title: pane.title, untouched: pane.untouched });
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

  // Browser surfaces have no PTY, so they never appear in the live-PTY set. Keep
  // them anyway — they are reconstructed from the saved layout blob / door
  // params (docs/specs/transport.md). Omitting them would drop the saved layout
  // (the visible-pane mismatch below) and lose minimized browser doors.
  const doors = (saved.doors ?? []).filter((item) => liveSet.has(item.id) || item.component === 'browser');
  const doorIds = new Set(doors.map((item) => item.id));
  const paneIds = saved.panes
    .filter((pane) => !doorIds.has(pane.id) && (liveSet.has(pane.id) || pane.surfaceType === 'browser'))
    .map((pane) => pane.id);
  const layoutPanelIds = getLayoutPanelIds(saved.layout);
  const layoutMatchesVisiblePanes =
    !!layoutPanelIds &&
    layoutPanelIds.length === paneIds.length &&
    layoutPanelIds.every((id) => paneIds.includes(id));

  // The Lath layout is gated in parallel (its leaf-meta keys are its pane set). The
  // two blobs are dual-written from one tree, so they agree; gating each on its own
  // extractor keeps a lone stale blob from being kept.
  const lathLeafIds = getLathLayoutLeafIds(saved.lathLayout);
  const lathMatchesVisiblePanes =
    !!lathLeafIds &&
    lathLeafIds.length === paneIds.length &&
    lathLeafIds.every((id) => paneIds.includes(id));

  return {
    paneIds: layoutMatchesVisiblePanes ? paneIds : paneIds.filter((id) => liveSet.has(id)),
    doors,
    layout: layoutMatchesVisiblePanes ? saved.layout : undefined,
    lathLayout: lathMatchesVisiblePanes ? saved.lathLayout : undefined,
  };
}

function getLayoutPanelIds(layout: unknown): string[] | null {
  if (!layout || typeof layout !== 'object') return null;
  const panels = (layout as { panels?: unknown }).panels;
  if (!panels || typeof panels !== 'object' || Array.isArray(panels)) return null;
  return Object.keys(panels);
}

/** Leaf ids of a Lath persisted layout (its `leafMeta` keys) — the pane-set the
 *  gate above compares against, parallel to `getLayoutPanelIds`. */
function getLathLayoutLeafIds(lathLayout: unknown): string[] | null {
  if (!lathLayout || typeof lathLayout !== 'object') return null;
  const leafMeta = (lathLayout as { leafMeta?: unknown }).leafMeta;
  if (!leafMeta || typeof leafMeta !== 'object' || Array.isArray(leafMeta)) return null;
  return Object.keys(leafMeta);
}

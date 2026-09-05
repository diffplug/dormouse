import type { LathPersistedLayout } from './lath/persistence';
import type { PlatformAdapter, PtyInfo } from './platform/types';
import { hydrateNotepadFromVolatile } from './notepad/notepad-store';
import { restoreBrowserSurfaceTodo, resumeTerminal } from './terminal-registry';
import { carrySurfaceRefs, readPersistedSession, type PersistedDoor, type PersistedSurfaceRefs } from './session-types';
import { persistedLathLayout, restoreSession } from './session-restore';

export interface ReconnectResult {
  paneIds: string[];
  /** The saved session's persisted Lath layout (`persistedLathLayout`), gated on its
   *  leaf set matching the visible pane set. */
  lathLayout?: LathPersistedLayout;
  doors?: PersistedDoor[];
  /** Workspace-scoped stable `dor` Surface refs restored with the session. */
  surfaceRefs?: PersistedSurfaceRefs;
  /** The Workspace's next `surface:N` counter, carried so a killed ref's number
   *  is never reused across a resume/restore. */
  surfaceRefsNext?: number;
}

/**
 * Resume over live PTYs, or cold-restore from saved session.
 *
 * Priority:
 * 1. Live PTYs (webview was hidden/shown) → resume with replay data
 * 2. Saved session (app restarted) → restore with saved cwd; nothing replays,
 *    because scrollback is never persisted (docs/specs/transport.md)
 * 3. Neither → return empty (Wall creates a fresh terminal)
 */
export async function resumeOrRestore(platform: PlatformAdapter): Promise<ReconnectResult> {
  const liveResult = await resumeLiveSessions(platform);
  if (liveResult) return liveResult;

  const restored = await restoreSession(platform);
  if (restored) {
    const saved = readPersistedSession(platform.getState());
    // Browser-only views have no PTY with which to prove a live resume. Their
    // host-memory mirror is that proof; an extension restart supplies null.
    // Rebuild their layout first, then hydrate only those surviving Surfaces.
    if (saved?.panes.length && saved.panes.every((pane) => pane.surfaceType === 'browser')) {
      return hydrateNotepad(platform, restored);
    }
    return restored;
  }

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
        const resumeInfo: { alive: boolean; exitCode?: number; shell?: string; title?: string; untouched?: boolean } = {
          alive: pty.alive,
          exitCode: pty.exitCode,
        };
        if (pty.shell !== undefined) resumeInfo.shell = pty.shell;
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
        resolve(hydrateNotepad(platform, savedPlan));
        return;
      }

      const saved = readPersistedSession(savedState);
      resolve(hydrateNotepad(platform, {
        paneIds: ids,
        doors: [],
        ...carrySurfaceRefs(saved),
      }));
    }

    platform.onPtyList(handleList);
    platform.onPtyReplay(handleReplay);
    platform.requestInit();
  });
}

/**
 * Give a resumed webview back the notes the host mirrored for it
 * (docs/specs/notepad.md → "Live resume"). Only reachable from the live-PTY
 * branch or a browser-only view with a same-host mirror: a cold restore is
 * a different Session over a different set of PTYs,
 * and mirrored notes must never surface there. Live Surfaces are the resume
 * plan's panes plus its doors — a minimized Surface keeps its notes.
 */
function hydrateNotepad(platform: PlatformAdapter, result: ReconnectResult): ReconnectResult {
  const snapshot = platform.notepadArchive?.loadVolatile?.();
  if (snapshot) {
    hydrateNotepadFromVolatile(snapshot, [...result.paneIds, ...(result.doors ?? []).map((door) => door.id)]);
  }
  return result;
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
  // Gate the layout on its leaf set matching the visible pane set, so a stale blob
  // is dropped rather than restored over a mismatched pane set.
  const lathLayout = persistedLathLayout(saved);
  const leafIds = lathLayout ? Object.keys(lathLayout.leafMeta) : null;
  const layoutMatchesVisiblePanes =
    !!leafIds &&
    leafIds.length === paneIds.length &&
    leafIds.every((id) => paneIds.includes(id));

  return {
    paneIds: layoutMatchesVisiblePanes ? paneIds : paneIds.filter((id) => liveSet.has(id)),
    doors,
    lathLayout: layoutMatchesVisiblePanes ? lathLayout : undefined,
    ...carrySurfaceRefs(saved),
  };
}

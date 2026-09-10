import { adoptOrphanedHelper, restoreHelper } from './helper-terminal';
import type { LathPersistedLayout } from './lath/persistence';
import type { PlatformAdapter, PtyInfo } from './platform/types';
import { hydrateNotepadFromVolatile } from './notepad/notepad-store';
import { restoreBrowserSurfaceTodo, resumeTerminal } from './terminal-registry';
import { carrySurfaceRefs, readPersistedSession, type PersistedDoor, type PersistedSession, type PersistedSurfaceRefs } from './session-types';
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

/** Every PTY the host still holds, with whatever replay each one sent. Collected
 *  ONCE per Window: the wait below is a single `requestInit` round trip, and the
 *  host answers it for the whole webview, not per Workspace. */
export interface LivePtys {
  ptys: PtyInfo[];
  replay: Map<string, string>;
}

/**
 * What one plan may claim out of `LivePtys`, and what it plans against. Every
 * field defaults to the whole-window answer, so the single-Wall hosts reach the
 * same behavior through `resumeOrRestore`.
 */
export interface ResumePlanOptions {
  /** The record to plan from; `undefined` reads the platform slot, `null` is "none". */
  savedSession?: PersistedSession | null;
  /** Live ids this plan owns by name. Omitted claims every live PTY. */
  ptyIds?: ReadonlySet<string>;
  /** Live ids no saved Workspace named, adopted by this plan — the active
   *  Workspace's, mirroring the unowned claim in
   *  `vscode-ext/src/message-router.ts`. An adopted id has no saved layout
   *  position, so a plan that takes one falls back to the flat live list, exactly
   *  as a single Wall does when a live PTY outruns its last save. */
  claimUnowned?: ReadonlySet<string>;
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
  return resumeOrRestoreFrom(platform, await collectLivePtys(platform));
}

/** How one collection differs from the ordinary boot one. */
export interface CollectPtysOptions {
  /** What makes the host answer. Defaults to `platform.requestInit()` — the
   *  whole Window. A Workspace arriving from another Window instead asks the
   *  host for exactly the PTYs whose ownership just moved to it. */
  trigger?: () => void;
  /** Which ids this collection is about; everything else in the answer is
   *  another Workspace's and must not be taken for it. */
  accept?: (id: string) => boolean;
  /** The ceiling on waiting for replays. */
  timeoutMs?: number;
}

/**
 * Ask the host for its PTYs and gather the replay each one sends back.
 *
 * Bounded rather than counted-to-completion: a host that lists PTYs but never
 * replays one of them must not hold up boot, so 500 ms is the ceiling and a
 * short list resolves as soon as every replay has arrived.
 */
export function collectLivePtys(
  platform: PlatformAdapter,
  options: CollectPtysOptions = {},
): Promise<LivePtys> {
  const accept = options.accept ?? (() => true);
  return new Promise<LivePtys>((resolve) => {
    const replay = new Map<string, string>();
    let ptyList: PtyInfo[] | null = null;

    const timeout = setTimeout(() => finish(), options.timeoutMs ?? 500);

    const handleList = (detail: { ptys: PtyInfo[] }) => {
      ptyList = detail.ptys.filter((pty) => accept(pty.id));
      if (ptyList.length === 0) {
        finish();
      }
    };

    const handleReplay = (detail: { id: string; data: string }) => {
      if (!accept(detail.id)) return;
      replay.set(detail.id, detail.data);
      if (ptyList && replay.size >= ptyList.length) {
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
      resolve({ ptys: ptyList ?? [], replay });
    }

    platform.onPtyList(handleList);
    platform.onPtyReplay(handleReplay);
    // Last: the handlers must be armed before anything can answer.
    (options.trigger ?? (() => platform.requestInit()))();
  });
}

/** The planning half of a resume/restore, over PTYs someone else collected. One
 *  call per Workspace, each taking its own slice of the one live list. */
export function resumeOrRestoreFrom(
  platform: PlatformAdapter,
  live: LivePtys,
  opts: ResumePlanOptions = {},
): ReconnectResult {
  const saved = opts.savedSession !== undefined
    ? opts.savedSession
    : readPersistedSession(platform.getState());

  const mine = live.ptys.filter((pty) =>
    opts.ptyIds === undefined || opts.ptyIds.has(pty.id) || opts.claimUnowned?.has(pty.id));
  const resumed = mine.length > 0 ? resumeLivePtys(mine, live.replay, saved) : null;
  if (resumed) return hydrateNotepad(platform, resumed);

  const restored = restoreSession(platform, { savedSession: saved });
  if (restored) {
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

function resumeLivePtys(
  ptyList: PtyInfo[],
  replayBuffer: Map<string, string>,
  saved: PersistedSession | null,
): ReconnectResult {
  const savedResumeInfo = getSavedPaneResumeInfo(saved, ptyList.map((pty) => pty.id));
  const ids: string[] = [];
  const ptyById = new Map(ptyList.map((pty) => [pty.id, pty]));
  for (const pty of ptyList) {
    const resumeInfo: { alive: boolean; exitCode?: number; shell?: string; title?: string; untouched?: boolean; helper?: PtyInfo['helper'] } = {
      alive: pty.alive,
      exitCode: pty.exitCode,
    };
    if (pty.shell !== undefined) resumeInfo.shell = pty.shell;
    const savedInfo = savedResumeInfo.get(pty.id);
    if (savedInfo?.title !== undefined) resumeInfo.title = savedInfo.title;
    if (savedInfo?.untouched) resumeInfo.untouched = true;
    // A helper stays one only while its source is also live; helpers cannot
    // have helpers. `ptyById` is this plan's slice, so a helper reaching a Wall
    // that does not hold its source is resumed as an ordinary pane instead — a
    // fallback, not a route: the Window planner sends every helper to its
    // source's Workspace (`routeUnownedPtys` in
    // `standalone/src/window-restore.ts`).
    const parent = pty.helper && ptyById.get(pty.helper.parentId);
    const helper = parent && !parent.helper ? pty.helper : undefined;
    if (helper) resumeInfo.helper = helper;
    resumeTerminal(pty.id, replayBuffer.get(pty.id) ?? null, resumeInfo);
    if (helper) { restoreHelper(pty.id, helper); continue; }
    ids.push(pty.id);
    if (pty.helper) adoptOrphanedHelper(pty.id);
  }
  // Pull saved visible/doors state so a resume (e.g. after panel
  // close/reopen) restores splits and doors instead of stacking every live
  // PTY into one tab group.
  return getSavedResumePlan(saved, ids) ?? {
    paneIds: ids,
    doors: [],
    ...carrySurfaceRefs(saved),
  };
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

function getSavedPaneResumeInfo(saved: PersistedSession | null, liveIds: string[]): Map<string, { title: string; untouched: boolean }> {
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

function getSavedResumePlan(saved: PersistedSession | null, liveIds: string[]): ReconnectResult | null {
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

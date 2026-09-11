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
  /** The host never answered this collection's own `requestInit`. **An empty
   *  `ptys` means "the host holds none" only when this is false**: a caller that
   *  cold-restores on a timeout starts fresh shells over PTYs that are still
   *  running (`planArrival` in `standalone/src/workspace-move.ts`). */
  timedOut: boolean;
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
  const savedSession = readPersistedSession(platform.getState());
  // The retry protects live shells from being restored over, and a record with
  // no terminal pane has none to lose: without the gate a host whose
  // `requestInit` answers nothing holds first paint for the whole budget
  // (`restoreWindow` in `standalone/src/window-restore.ts` gates the same way).
  const hasTerminalPanes =
    savedSession?.panes.some((pane) => pane.surfaceType !== 'browser') ?? false;
  const live = await collectLivePtys(
    platform,
    hasTerminalPanes ? { retryTimeoutMs: LIST_RETRY_MS } : {},
  );
  return resumeOrRestoreFrom(platform, live, { savedSession });
}

/** How one collection differs from the ordinary boot one. */
export interface CollectPtysOptions {
  /** What makes the host answer, given this collection's own token to carry.
   *  Defaults to `platform.requestInit(requestId)` — the whole Window. A
   *  Workspace arriving from another Window instead asks the host for exactly
   *  the PTYs whose ownership just moved to it. */
  trigger?: (requestId: string) => void;
  /** Which ids this collection is about; everything else in the answer is
   *  another Workspace's and must not be taken for it. */
  accept?: (id: string) => boolean;
  /** The ceiling on waiting for replays. */
  timeoutMs?: number;
  /** Ask once more on this budget when the host never answered at all. Omitted:
   *  one attempt (`collectLivePtysOnce`). */
  retryTimeoutMs?: number;
}

/**
 * The second ask's budget when the first got no `pty:list` at all.
 *
 * A `timedOut` list is the input a cold restore reads as "the host holds
 * nothing", and acting on it starts a second set of shells over the ones still
 * running. A launch slow enough to outrun 500 ms — a cold sidecar behind an
 * antivirus scan — is exactly when that happens, so the host is asked once more
 * before its silence is believed. Costs nothing when there is nothing to say:
 * an empty list still resolves as soon as it arrives.
 */
export const LIST_RETRY_MS = 3000;

/** Distinct per collection and per webview reload; only ever compared for
 *  equality against the host's echo. */
let collectSeq = 0;

/**
 * Ask the host for its PTYs and gather the replay each one sends back.
 *
 * Bounded rather than counted-to-completion: a host that lists PTYs but never
 * replays one of them must not hold up boot, so 500 ms is the ceiling and a
 * short list resolves as soon as every replay has arrived.
 *
 * **Finishes only on its own answer.** Every listener sees every `pty:list`, so
 * one window running two collections at once — a boot and a Workspace arriving,
 * or two arrivals — would otherwise let each finish on the other's list and
 * conclude the host holds nothing. The token rides the `requestInit` and comes
 * back on the list and each replay; an answer carrying none is a host that does
 * not echo it (VS Code, Pocket, the website), which has one collector anyway.
 *
 * **Asks twice before believing silence**, on `retryTimeoutMs`: the whole
 * difference between "the host holds nothing" and "the host never answered" is
 * `timedOut`, and a caller that cold-restores on the second starts a second set
 * of shells over the ones still running.
 */
export async function collectLivePtys(
  platform: PlatformAdapter,
  options: CollectPtysOptions = {},
): Promise<LivePtys> {
  const first = await collectLivePtysOnce(platform, options);
  if (!first.timedOut || options.retryTimeoutMs === undefined) return first;
  return collectLivePtysOnce(platform, { ...options, timeoutMs: options.retryTimeoutMs });
}

/** One ask and one wait. `collectLivePtys` is this, plus the retry. */
function collectLivePtysOnce(
  platform: PlatformAdapter,
  options: CollectPtysOptions = {},
): Promise<LivePtys> {
  const accept = options.accept ?? (() => true);
  const requestId = `init-${++collectSeq}`;
  const mine = (detail: { requestId?: string }) =>
    detail.requestId === undefined || detail.requestId === requestId;
  return new Promise<LivePtys>((resolve) => {
    const replay = new Map<string, string>();
    let ptyList: PtyInfo[] | null = null;

    const timeout = setTimeout(() => finish(), options.timeoutMs ?? 500);

    const handleList = (detail: { ptys: PtyInfo[]; requestId?: string }) => {
      if (!mine(detail)) return;
      ptyList = detail.ptys.filter((pty) => accept(pty.id));
      if (ptyList.length === 0) {
        finish();
      }
    };

    const handleReplay = (detail: { id: string; data: string; requestId?: string }) => {
      if (!mine(detail) || !accept(detail.id)) return;
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
      resolve({ ptys: ptyList ?? [], replay, timedOut: ptyList === null });
    }

    platform.onPtyList(handleList);
    platform.onPtyReplay(handleReplay);
    // Last: the handlers must be armed before anything can answer.
    (options.trigger ?? ((token: string) => platform.requestInit(token)))(requestId);
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

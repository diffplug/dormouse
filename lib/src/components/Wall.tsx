import { useRef, useState, useEffect, useCallback, useMemo, useSyncExternalStore, lazy, Suspense, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Baseboard } from './Baseboard';
import { ExternalLinkModalHost } from './ExternalLinkModalHost';
import { AgentBrowserScreenModalHost } from './AgentBrowserScreenModalHost';
// Remote-host code (relay/WebSocket/enrollment + the window.dormouseRemoteHost
// console hook) is loaded and mounted only when the embedding runtime opts in
// via `enableRemoteHost` — see the mount below. Lazy so it stays out of the
// website playground and vscode webview bundles, which never enable it.
const RemotePairingModalHost = lazy(() =>
  import('../remote/host/RemotePairingModalHost').then((m) => ({
    default: m.RemotePairingModalHost,
  })),
);
import { getAgentBrowserScreenController } from './wall/agent-browser-screen';
import { markAgentBrowserSessionClosed } from './wall/agent-browser-sessions';
import { disposeAgentBrowserSurfaceController } from './wall/agent-browser-surface-controller';
import { KILL_CONFIRM_MS, KILL_SHAKE_MS, KillConfirmOverlay, randomKillChar, type ConfirmKill } from './KillConfirm';
import {
  clearSessionAttention,
  clearLocalSurfaceActivity,
  disposeSession,
  dismissOrToggleAlert,
  focusSession,
  markSessionAttention,
  toggleSessionTodo,
  setPendingShellOpts,
  getDefaultShellOpts,
  getTerminalPaneState,
  getTerminalPaneStateSnapshot,
  getActivitySnapshot,
  isUntouched,
  getOrCreateTerminal,
  setTerminalUserTitle,
  UNNAMED_PANEL_TITLE,
  type SessionStatus,
} from '../lib/terminal-registry';
import {
  buildAppTitleResolver,
  createTerminalPaneState,
  deriveSurfaceLabel,
} from '../lib/terminal-state';
import { getPlatform } from '../lib/platform';
import type {
  Surface as DorSurface,
  ResolvedSplitDirection as DorResolvedSplitDirection,
  ParseResult,
  SurfaceRenderMode as DorSurfaceRenderMode,
  SurfaceView as DorSurfaceView,
} from 'dor/commands/types';
import { hasBrowser, hasTerminal } from 'dor/commands/types';
import type { PersistedDoor, PersistedSurfaceRefs } from '../lib/session-types';
import type { DropTarget, RestoreToken } from '../lib/lath/ops';
import type { Edge } from '../lib/lath/model';
import { useDynamicPalette } from '../lib/themes/use-dynamic-palette';
import { resolveRenderMode, agentBrowserSessionFromParams, browserUrlFromParams, isToolParams, namespacedToolKey, surfaceKindFromParams, toolPendingFromParams } from './wall/browser-surface';
import { hostPathDisplay } from './wall/browser-url';
import { WorkspaceSelectionOverlay } from './wall/WorkspaceSelectionOverlay';
import { LathHost } from './wall/LathHost';
import {
  type LathWallEngine,
  createLathWallEngine,
  terminalLeafMeta,
  browserLeafMeta,
  shouldParkOnMinimize,
  edgeForDorDirection,
  directionForArrow,
} from './wall/lath-wall-engine';
import type { LeafMeta } from '../lib/lath/persistence';
import { useToolServing } from './wall/use-tool-serving';
import type { WallNav } from './wall/keyboard/types';
import { useWallKeyboard } from './wall/use-wall-keyboard';
import { useSessionPersistence } from './wall/use-session-persistence';
import { useDevServerPortCorrelation } from './wall/use-dev-server-ports';
import { useAlertSpeech } from './wall/use-alert-speech';
import { useDorControl } from './wall/use-dor-control';
import { useWindowFocused } from './wall/use-window-focused';
import {
  DialogKeyboardContext,
  DoorElementsContext,
  ModeContext,
  PaneElementsContext,
  PaneWriteContext,
  WallActionsContext,
  RenamingIdContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedIdContext,
  type PaneWriteActions,
  type WallActions,
} from './wall/wall-context';
import type { DoorAfterRestoreAction, DoorChip, DooredItem, WallEvent, WallMode, WallSelectionKind } from './wall/wall-types';

type ShellSpawnRequest = {
  shell?: string;
  args?: string[];
  name?: string;
  replaceUntouched?: boolean;
  announce?: boolean;
};

type ShellSpawnNoticeState = {
  id: string;
  text: string;
  nonce: number;
};

export type { DoorAfterRestoreAction, DoorChip, DooredItem, WallEvent, WallMode, WallSelectionKind } from './wall/wall-types';
export {
  DialogKeyboardContext,
  DoorElementsContext,
  ModeContext,
  WallActionsContext,
  RenamingIdContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedIdContext,
} from './wall/wall-context';
export type { WallActions } from './wall/wall-context';
export { SelectionRing } from './wall/SelectionRing';
export { roundedRectPath } from '../lib/ring-geometry';
export { TerminalPaneHeader } from './wall/TerminalPaneHeader';

function persistedPanelTitle(title: string | null | undefined): string {
  const trimmed = title?.trim();
  return trimmed || UNNAMED_PANEL_TITLE;
}

function surfaceRenderModeFromParams(params: unknown): DorSurfaceRenderMode | null {
  // Same capability gate as the row's `url`, so both browser-side fields answer
  // "does this Surface have a browser?" one way.
  return hasBrowser(surfaceKindFromParams(params)) ? resolveRenderMode(params) : null;
}

function surfaceRefNumber(ref: string): number | null {
  const match = /^surface:([1-9]\d*)$/.exec(ref);
  return match ? Number(match[1]) : null;
}

function createSurfaceRefRegistry(
  initialSurfaceRefs: PersistedSurfaceRefs | undefined,
  initialSurfaceRefsNext: number | undefined,
): {
  refs: Map<string, string>;
  nextIndex: number;
} {
  const refs = new Map<string, string>();
  let max = 0;
  for (const [id, ref] of Object.entries(initialSurfaceRefs ?? {})) {
    const n = surfaceRefNumber(ref);
    if (!id || n === null) continue;
    refs.set(id, ref);
    max = Math.max(max, n);
  }
  // The counter is the source of truth (killed entries are pruned from the map, so
  // `max` alone would let a pruned number be reused). Clamp above `max` too, so a
  // stale/absent persisted counter can never hand out a live ref's number.
  const persistedNext = initialSurfaceRefsNext !== undefined && Number.isInteger(initialSurfaceRefsNext)
    ? initialSurfaceRefsNext
    : 0;
  return { refs, nextIndex: Math.max(persistedNext, max + 1) };
}

function compareBySurfaceRef(a: DorSurface, b: DorSurface): number {
  return (surfaceRefNumber(a.ref) ?? Number.MAX_SAFE_INTEGER)
    - (surfaceRefNumber(b.ref) ?? Number.MAX_SAFE_INTEGER);
}

/** Killing or swapping away from an agent-browser surface closes its session —
 *  surface lifetime and browser lifetime are bound (spec → Lifecycle). No-op
 *  for other surface types. */
function closeAgentBrowserSession(params: unknown): void {
  const session = agentBrowserSessionFromParams(params);
  if (!session) return;
  const binaryPath = (params as { binaryPath?: unknown }).binaryPath;
  // Mark before issuing the close so a popped-out surface's auto-revert sees
  // the impending teardown and doesn't relaunch the session we're killing.
  markAgentBrowserSessionClosed(session);
  getPlatform().agentBrowserCommand?.(
    session,
    ['close'],
    typeof binaryPath === 'string' ? binaryPath : undefined,
  ).catch(() => {});
}

function ShellSpawnNotice({
  notice,
  paneElements,
  version,
}: {
  notice: ShellSpawnNoticeState | null;
  paneElements: Map<string, HTMLElement>;
  version: number;
}) {
  void version;
  if (!notice) return null;
  const target = paneElements.get(notice.id);
  if (!target) return null;
  const rect = target.getBoundingClientRect();
  return (
    <div
      key={notice.nonce}
      className="shell-spawn-notice pointer-events-none fixed z-[90] rounded border border-border bg-surface-raised px-2.5 py-1 font-mono text-xs text-foreground shadow-md"
      style={{
        top: rect.top + 38,
        left: rect.left + rect.width / 2,
        transform: 'translateX(-50%)',
      }}
    >
      {notice.text}
    </div>
  );
}

// --- Main component ---

export function Wall({
  initialPaneIds,
  initialMode = 'command',
  restoredLathLayout,
  initialDoors,
  initialSurfaceRefs,
  initialSurfaceRefsNext,
  onEvent,
  baseboardNotice,
  dialogHost,
  showBaseboard = true,
  enableRemoteHost = false,
}: {
  initialPaneIds?: string[];
  initialMode?: WallMode;
  /** The restored Lath persisted layout (docs/specs/tiling-engine.md →
   *  "Persistence"). */
  restoredLathLayout?: unknown;
  initialDoors?: PersistedDoor[];
  initialSurfaceRefs?: PersistedSurfaceRefs;
  initialSurfaceRefsNext?: number;
  onEvent?: (event: WallEvent) => void;
  baseboardNotice?: ReactNode;
  /**
   * Host-provided modal host(s) (e.g. the standalone quit-confirmation dialog),
   * mounted beside the built-in modal hosts inside the Wall's
   * `DialogKeyboardContext` provider so they can suppress command-mode keyboard
   * dispatch while visible. Unlike `baseboardNotice`, this renders regardless
   * of `showBaseboard`.
   */
  dialogHost?: ReactNode;
  showBaseboard?: boolean;
  /**
   * Opt in to the remote-control Host (the "Pocket" pairing seam). Only the
   * standalone desktop/sidecar runtime sets this; the website playground and
   * vscode webview leave it off so the remote-host stack and its
   * `window.dormouseRemoteHost` console hook never load there.
   */
  enableRemoteHost?: boolean;
} = {}) {
  // The Lath engine handle — Dormouse's tiling engine. Constructed lazily exactly
  // once per Wall mount, so `createLathWallEngine` is not re-invoked each render
  // (docs/specs/tiling-engine.md).
  const lathRef = useRef<LathWallEngine | null>(null);
  if (lathRef.current === null) lathRef.current = createLathWallEngine();
  const lath = lathRef.current;
  const restoredLathLayoutRef = useRef(restoredLathLayout);
  const dorSurfaceRefsRef = useRef<Map<string, string> | null>(null);
  const nextDorSurfaceRefIndexRef = useRef(1);
  if (dorSurfaceRefsRef.current === null) {
    const registry = createSurfaceRefRegistry(initialSurfaceRefs, initialSurfaceRefsNext);
    dorSurfaceRefsRef.current = registry.refs;
    nextDorSurfaceRefIndexRef.current = registry.nextIndex;
  }

  // Pane ID generation (instance-scoped, not module-level)
  const paneCounterRef = useRef(0);
  const generatePaneId = useCallback(() => {
    return `pane-${(++paneCounterRef.current).toString(36)}-${Math.random().toString(36).substring(2, 7)}`;
  }, []);
  const surfaceRefForId = useCallback((id: string): string => {
    const refs = dorSurfaceRefsRef.current!;
    const existing = refs.get(id);
    if (existing) return existing;
    const ref = `surface:${nextDorSurfaceRefIndexRef.current++}`;
    refs.set(id, ref);
    return ref;
  }, []);
  // Drop a Surface's ref when it is killed. The counter never rewinds, so its
  // `surface:N` is retired, not reused — a later target that names it fails
  // instead of resolving to a different Surface (spec → Handle Model).
  const forgetSurfaceRef = useCallback((id: string): void => {
    dorSurfaceRefsRef.current!.delete(id);
  }, []);
  const transferSurfaceRef = useCallback((fromId: string, toId: string): string => {
    const ref = surfaceRefForId(fromId);
    dorSurfaceRefsRef.current!.set(toId, ref);
    // The old leaf is being replaced (e.g. a browser render-mode swap); its id is
    // dead, so hand the ref to the new id and drop the stale entry.
    dorSurfaceRefsRef.current!.delete(fromId);
    return ref;
  }, [surfaceRefForId]);
  const surfaceRefsForSave = useCallback((): { refs: PersistedSurfaceRefs; next: number } => {
    return {
      refs: Object.fromEntries(dorSurfaceRefsRef.current!),
      next: nextDorSurfaceRefIndexRef.current,
    };
  }, []);

  const dialogKeyboardActiveRef = useRef(false);
  const setDialogKeyboardActive = useCallback((active: boolean) => {
    dialogKeyboardActiveRef.current = active;
  }, []);

  // Consumed once by the Lath seed effect to restore existing sessions
  const initialPaneIdsRef = useRef(initialPaneIds);

  // Mutable maps shared via context — consumers must call bumpVersion() after
  // any mutation so that dependent effects/components re-run.
  const paneElementsRef = useRef(new Map<string, HTMLElement>());
  const paneElements = paneElementsRef.current;
  const [paneElementsVersion, setPaneElementsVersion] = useState(0);
  const doorElementsRef = useRef(new Map<string, HTMLElement>());
  const doorElements = doorElementsRef.current;
  const [doorElementsVersion, setDoorElementsVersion] = useState(0);
  const bumpPaneElementsVersion = useCallback(() => {
    setPaneElementsVersion((v) => v + 1);
  }, []);
  const bumpDoorElementsVersion = useCallback(() => {
    setDoorElementsVersion((v) => v + 1);
  }, []);
  // Memoize the context payloads so a Wall re-render only hands consumers a new object
  // when the version actually bumps (the map + bumper identities are already stable).
  const paneElementsContextValue = useMemo(
    () => ({ elements: paneElements, version: paneElementsVersion, bumpVersion: bumpPaneElementsVersion }),
    [paneElements, paneElementsVersion, bumpPaneElementsVersion],
  );
  const doorElementsContextValue = useMemo(
    () => ({ elements: doorElements, version: doorElementsVersion, bumpVersion: bumpDoorElementsVersion }),
    [doorElements, doorElementsVersion, bumpDoorElementsVersion],
  );

  // Selection/focus/mode policy lives here in the Wall; Lath owns only geometry.
  const [mode, setMode] = useState<WallMode>(initialMode);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedType, setSelectedType] = useState<WallSelectionKind>('pane');

  const windowFocused = useWindowFocused();
  useDynamicPalette();

  // UI state
  const [confirmKill, setConfirmKill] = useState<ConfirmKill | null>(null);
  const [renamingPaneId, setRenamingPaneId] = useState<string | null>(null);
  // Runtime Doors carry id + token only; the restored rows' metadata goes into the
  // store via the seed effect below.
  const initialDoorsRef = useRef(initialDoors);
  const [doors, setDoors] = useState<DooredItem[]>(
    () => (initialDoors ?? []).map((door) => ({ id: door.id, token: door.token })),
  );
  // The Door being dragged out of the baseboard: the item + the press point LathHost
  // starts its threshold-gated external drag from. Non-null feeds LathHost's
  // external-drag hit-testing; the chip stays in `doors` until it lands on a target.
  const [doorDrag, setDoorDrag] = useState<{ item: DooredItem; startX: number; startY: number } | null>(null);
  // Zoom is presentation state the store owns (`zoomedId`, cleared when a kill/replace
  // removes the zoomed leaf). Subscribe to the id (not only its boolean projection)
  // because focus policy needs to know whether a transition stays on that exact pane.
  const zoomedId = useSyncExternalStore(lath.store.subscribe, () => lath.store.getSnapshot().zoomedId);
  const zoomed = zoomedId !== null;
  const [shellSpawnNotice, setShellSpawnNotice] = useState<ShellSpawnNoticeState | null>(null);
  const shellSpawnNoticeCounterRef = useRef(0);
  const shellSpawnNoticeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Keep the approval prompt mounted until its shell launch is fully staged.
  // The Set suppresses duplicate button clicks without exposing the terminal
  // half early (toolPending is the render-time no-PTY guard).
  const toolApprovalsInFlightRef = useRef<Set<string>>(new Set());

  // Use refs so the capture-phase listener always sees latest state without re-registering
  const modeRef = useRef(mode);
  modeRef.current = mode;
  const selectedIdRef = useRef(selectedId);
  selectedIdRef.current = selectedId;
  const selectedTypeRef = useRef(selectedType);
  selectedTypeRef.current = selectedType;
  const doorsRef = useRef(doors);
  doorsRef.current = doors;
  // Door chip labels live in the store, so Wall has to re-render when one changes —
  // but only then. Subscribing to the joined titles (rather than to `revision`) keeps
  // a Doored Surface that keeps running — a parked iframe navigating — from leaving a
  // stale label, without waking Wall on every unrelated commit.
  const doorTitles = useSyncExternalStore(lath.store.subscribe, () => {
    const meta = lath.store.getSnapshot().leafMeta;
    return doorsRef.current.map((door) => meta.get(door.id)?.title ?? '').join('\u0000');
  });
  // The Baseboard's chips: the runtime Doors plus the store's current fallback title
  // for each, projected per render rather than stored, so no copy can go stale.
  const doorChips = useMemo<DoorChip[]>(
    () => doors.map((door) => ({ ...door, title: persistedPanelTitle(lath.getMeta(door.id)?.title) })),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `doorTitles` is the store read
    [doors, lath, doorTitles],
  );
  const confirmKillRef = useRef(confirmKill);
  confirmKillRef.current = confirmKill;

  // The navigation/query seam for the keyboard handlers, backed by the engine + its
  // store. State queries (`neighborOf` / `has` / pre-order `leafIds`) go straight to
  // the store; `paneParams` reads the engine's meta projection.
  const nav = useMemo<WallNav>(() => ({
    findInDirection: (id, dir) => lath.store.neighborOf(id, directionForArrow(dir)),
    paneParams: (id) => lath.getMeta(id)?.params,
    hasPane: (id) => lath.store.has(id),
    panes: () => lath.store.leafIds(),
  }), [lath]);
  const renamingRef = useRef(renamingPaneId);
  renamingRef.current = renamingPaneId;
  const shakeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!confirmKill && shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
  }, [confirmKill]);

  useEffect(() => () => {
    if (shakeTimerRef.current) clearTimeout(shakeTimerRef.current);
    if (confirmTimerRef.current) clearTimeout(confirmTimerRef.current);
    if (shellSpawnNoticeTimerRef.current) clearTimeout(shellSpawnNoticeTimerRef.current);
  }, []);

  // --- External event notifications ---
  const onEventRef = useRef(onEvent);
  onEventRef.current = onEvent;
  const fireEvent = useCallback((event: WallEvent) => {
    onEventRef.current?.(event);
  }, []);

  // Confirm runs the kill (its fade) concurrently with the letter flash so the
  // pane fade begins while the flash is still playing.
  const rejectKill = useCallback(() => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    setConfirmKill({ ...ck, exit: 'shake' });
    shakeTimerRef.current = setTimeout(() => setConfirmKill(null), KILL_SHAKE_MS);
  }, []);

  useEffect(() => { onEventRef.current?.({ type: 'modeChange', mode }); }, [mode]);
  useEffect(() => { onEventRef.current?.({ type: 'zoomChange', zoomed }); }, [zoomed]);
  useEffect(() => { onEventRef.current?.({ type: 'minimizeChange', count: doors.length }); }, [doors]);
  useEffect(() => { onEventRef.current?.({ type: 'selectionChange', id: selectedId, kind: selectedType }); }, [selectedId, selectedType]);

  // --- Helpers ---

  /** Zoom belongs to the focused passthrough pane (docs/specs/layout.md → "Zoom"),
   *  so every focus transition off its owner starts the return to the tiled layout.
   *  `keepId` is the pane the transition lands on, or null when focus leaves panes
   *  entirely (a Door, or back to the Wall). `setZoomed` no-ops when already there. */
  const releaseZoomExcept = useCallback((keepId: string | null = null) => {
    if (lath.store.getSnapshot().zoomedId !== keepId) lath.store.setZoomed(null);
  }, [lath]);

  /** Select a pane: the Wall state is the sole selection authority (Lath has no
   *  concept of selection/activation). */
  const selectPane = useCallback((id: string) => {
    releaseZoomExcept(id);
    selectedIdRef.current = id;
    selectedTypeRef.current = 'pane';
    setSelectedId(id);
    setSelectedType('pane');
  }, [releaseZoomExcept]);

  // The shared tail of both reattach paths (click-reattach + drag-out): drop the Door
  // chip from the baseboard and select the now-restored pane.
  const removeDoorAndSelect = useCallback((id: string) => {
    const nextDoors = doorsRef.current.filter(d => d.id !== id);
    doorsRef.current = nextDoors;
    setDoors(nextDoors);
    selectPane(id);
  }, [selectPane]);

  // Swap two panes' surfaces (Cmd-Arrow): swap leaf identities — meta and registry
  // entries follow ids, so there is no companion title swap.
  const swapWithNeighbor = useCallback((fromId: string, toId: string) => {
    lath.store.swapLeaves(fromId, toId);
  }, [lath]);

  // The selection tail of a surface-adding op. A non-focus-neutral add selects the
  // new pane; a focus-neutral add moves selection onto it only when it replaced the
  // pane the user was selected on.
  const settleAddSelection = useCallback((focusNeutral: boolean, selectionReplaced: boolean, newId: string): boolean => {
    if (!focusNeutral || selectionReplaced) { selectPane(newId); return true; }
    return false;
  }, [selectPane]);

  const showShellSpawnNotice = useCallback((id: string, text: string) => {
    if (shellSpawnNoticeTimerRef.current) {
      clearTimeout(shellSpawnNoticeTimerRef.current);
    }
    setShellSpawnNotice({
      id,
      text,
      nonce: ++shellSpawnNoticeCounterRef.current,
    });
    shellSpawnNoticeTimerRef.current = setTimeout(() => {
      setShellSpawnNotice(null);
      shellSpawnNoticeTimerRef.current = null;
    }, 1500);
  }, []);

  const killPaneImmediately = useCallback((id: string) => {
    // A second kill for a pane already mid-fade is a no-op (idempotent) — it must
    // not re-fire the event, re-dispose, or schedule a second removal.
    if (lath.isDying(id)) return;
    const isVisiblePane = nav.hasPane(id);
    if (!isVisiblePane) {
      // A doored surface has no visible pane but still owns a live session
      // (its PTY keeps running). `dor ensure --minimize`'s integration-timeout
      // teardown lands here: the throwaway was created straight into a door.
      const door = doorsRef.current.find(d => d.id === id);
      if (!door) return;
      closeAgentBrowserSession(lath.getMeta(id)?.params);
      disposeAgentBrowserSurfaceController(id);
      // Destroy the Door: drop the meta the store kept for it and, if it was parked,
      // unmount the DOM (and any iframe document still running inside it) with it.
      lath.store.forgetLeaf(id);
      // Dispose the session/registry entry — this stops the PTY and makes a
      // still-armed typeCommandWhenPromptReady exit via its `!registry.has(id)`
      // check, so a late OSC signal can't type the command into a dead surface.
      disposeSession(id);
      const nextDoors = doorsRef.current.filter(d => d.id !== id);
      doorsRef.current = nextDoors;
      setDoors(nextDoors);
      // Guard: no current caller kills a selected door (ensure's throwaway is
      // never selected), but if one did, fall back to a visible pane.
      if (selectedIdRef.current === id && selectedTypeRef.current === 'door') {
        const survivorId = lath.listPanes()[0]?.id ?? null;
        if (survivorId) selectPane(survivorId);
        else setSelectedId(null);
      }
      clearLocalSurfaceActivity(id);
      forgetSurfaceRef(id);
      fireEvent({ type: 'kill', id });
      return;
    }
    const params = nav.paneParams(id);
    closeAgentBrowserSession(params);
    // Release the surface's client-side controller (connection, loops, timers,
    // screen registration). A safe no-op for iframe/terminal surfaces.
    disposeAgentBrowserSurfaceController(id);
    // Two-phase kill (docs/specs/tiling-engine.md → "Animation"): fade the pane in
    // place (a last-pane kill also shrinks it toward the bottom-right), then commit
    // `remove` once the fade completes — survivors tween into the reclaimed space.
    // Keep the mounted terminal DOM through the fade so the visible content fades
    // in place; dispose in the finalizer. The restore token is discarded (kills
    // don't restore).
    const lastLeaf = lath.store.leafIds().length === 1;
    lath.markDying(id, { shrinkTowardBottomRight: lastLeaf });
    setTimeout(() => {
      if (!lath.store.has(id)) return; // superseded meanwhile (e.g. replaced)
      disposeSession(id);
      // Live re-read at removal time: only a kill of the still-selected pane moves
      // selection; navigating away mid-fade is honored. Removing the last leaf
      // empties the tree and the auto-spawn effect fills it.
      const wasSelectedPane = selectedTypeRef.current === 'pane' && selectedIdRef.current === id;
      lath.store.removeLeaf(id);
      // Forget the ref only now — while the pane is fading it is still in
      // `listPanes()`, so an earlier delete would let a `dor` projection re-mint a
      // fresh ref for the dying pane.
      forgetSurfaceRef(id);
      if (wasSelectedPane) {
        const survivorId = lath.listPanes()[0]?.id ?? null;
        if (survivorId) selectPane(survivorId);
        else setSelectedId(null);
      }
    }, lath.exitMs);
    clearLocalSurfaceActivity(id);
    fireEvent({ type: 'kill', id });
  }, [fireEvent, forgetSurfaceRef, selectPane, lath, nav]);

  const acceptKill = useCallback(() => {
    const ck = confirmKillRef.current;
    if (!ck || ck.exit) return;
    const staged = { ...ck, exit: 'confirm' as const };
    // Written to the ref synchronously, not just via setState: the ref otherwise
    // updates on the NEXT render, so a second confirm keydown arriving before
    // React flushes would pass this guard and kill the same pane twice. (Lath's
    // `isDying` guard in killPaneImmediately is the second line of defense.)
    confirmKillRef.current = staged;
    setConfirmKill(staged);
    killPaneImmediately(ck.id);
    confirmTimerRef.current = setTimeout(() => setConfirmKill(null), KILL_CONFIRM_MS);
  }, [killPaneImmediately]);

  /** Select a door in the baseboard */
  const selectDoor = useCallback((id: string) => {
    releaseZoomExcept();
    selectedIdRef.current = id;
    selectedTypeRef.current = 'door';
    setSelectedId(id);
    setSelectedType('door');
  }, [releaseZoomExcept]);

  /** Enter terminal mode for the given panel */
  const enterTerminalMode = useCallback((id: string) => {
    selectPane(id);
    modeRef.current = 'passthrough';
    setMode('passthrough');
    markSessionAttention(id);
    // Defer focus so it happens after the mousedown/click event finishes.
    requestAnimationFrame(() => focusSession(id, true));
  }, [selectPane]);
  const enterTerminalModeRef = useRef(enterTerminalMode);
  enterTerminalModeRef.current = enterTerminalMode;

  /** Minimize a pane: detach the leaf (capturing its restore token) and add a Door.
   *
   *  A browser Surface **parks** instead of being removed: its state lives in the
   *  DOM (an `<iframe>`'s document, a screencast canvas), which a plain remove would
   *  destroy — reattaching would then be a reload. Parking keeps the leaf mounted and
   *  invisible so the document survives intact (docs/specs/tiling-engine.md →
   *  "Parked leaves"). Terminals do not park: their state lives in the PTY and the
   *  registry replays it, so the existing remove/restore path already loses nothing. */
  const minimizePane = useCallback((id: string, opts?: { select?: boolean }) => {
    const meta = lath.getMeta(id);
    if (!meta) return;
    // May auto-spawn if this was the last leaf. `doorLeaf` retains the leaf's meta in
    // the store (it keeps changing while minimized) and caps the parked set itself.
    const { token } = lath.store.doorLeaf(id, { park: shouldParkOnMinimize(meta) });
    if (!token) return;
    clearSessionAttention(id);
    // The runtime Door is identity + the core restore payload only
    // (docs/specs/tiling-engine.md → "Restore tokens"); its metadata stays in the
    // store, and the persisted row is materialized from there at save time.
    const door: DooredItem = { id, token };

    const nextDoors = [...doorsRef.current, door];
    doorsRef.current = nextDoors;
    setDoors(nextDoors);

    // Keep the minimized session selected as a door so the user can track where it went.
    // A focus-neutral creation (`dor ensure --minimize`) opts out: it must leave the
    // caller's mode and selection untouched (see createSplitSurface's focusNeutral).
    if (opts?.select !== false) {
      modeRef.current = 'command';
      setMode('command');
      selectDoor(id);
    }
  }, [selectDoor, lath]);

  const addMinimizedSplitDoor = useCallback((referenceId: string, item: DooredItem, select: boolean) => {
    const index = doorsRef.current.findIndex((door) => door.id === referenceId);
    const insertAt = index >= 0 ? index + 1 : doorsRef.current.length;
    const nextDoors = [
      ...doorsRef.current.slice(0, insertAt),
      item,
      ...doorsRef.current.slice(insertAt),
    ];
    doorsRef.current = nextDoors;
    setDoors(nextDoors);
    if (select) {
      modeRef.current = 'command';
      setMode('command');
      selectDoor(item.id);
    }
  }, [selectDoor]);

  /** Exit terminal mode */
  const exitTerminalMode = useCallback(() => {
    // Giving keyboard focus back to the Wall ends zoom even though command-mode
    // selection remains on the pane.
    releaseZoomExcept();
    modeRef.current = 'command';
    setMode('command');
    const id = selectedIdRef.current;
    if (id) focusSession(id, false);
  }, [releaseZoomExcept]);

  useEffect(() => {
    // An iframe surface taking focus blurs this window without backgrounding the
    // app (document.hasFocus() stays true). Only clear cross-session attention
    // on a real blur, else focusing an iframe wipes attention
    // (docs/specs/layout.md → Corner cases #2).
    const handleBlur = () => {
      if (document.hasFocus()) return;
      clearSessionAttention();
    };
    window.addEventListener('blur', handleBlur);
    return () => window.removeEventListener('blur', handleBlur);
  }, []);

  // --- Lath seed + auto-spawn ---
  const lathSeededRef = useRef(false);
  // The leaf-id set as of the last commit, so the store subscription can fire
  // `paneAdded` for ids that just appeared (splits, dor surfaces, restores,
  // auto-spawn). Seeded here so the seed ids are NOT re-fired by the diff — they
  // are announced explicitly below (the initial adds).
  const prevLeafIdsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    if (lathSeededRef.current) return;
    lathSeededRef.current = true;

    // Hydrate: the restored Lath layout when usable, else fresh panes. The restored
    // Door rows ride along so their meta lands in the store, which owns it from here
    // — the runtime `doors` state keeps only id + token.
    const { paneIds, fresh } = lath.seed(
      restoredLathLayoutRef.current,
      initialPaneIdsRef.current,
      generatePaneId,
      initialDoorsRef.current,
    );
    for (const id of paneIds) surfaceRefForId(id);
    for (const door of doorsRef.current) surfaceRefForId(door.id);
    // Prime default-shell opts for the fresh path's generated ids (a no-op for
    // already-restored ids).
    if (fresh) {
      const defaults = getDefaultShellOpts();
      if (defaults?.shell) {
        for (const id of paneIds) setPendingShellOpts(id, { shell: defaults.shell, args: defaults.args });
      }
    }
    setSelectedId(paneIds[0] ?? null);
    // Announce the seeded panes and prime the diff set so the store subscription
    // only fires for ids added later (the seed's own commits predate its subscribe).
    prevLeafIdsRef.current = new Set(paneIds);
    for (const id of paneIds) fireEvent({ type: 'paneAdded', id });
  }, [lath, generatePaneId, fireEvent, surfaceRefForId]);

  // Auto-spawn: whenever a commit empties the tree (last pane killed/minimized),
  // spawn one to keep a pane visible — the Wall's "always one pane" rule.
  useEffect(() => {
    return lath.store.subscribe(() => {
      const snap = lath.store.getSnapshot();
      // `paneAdded` for any leaf new since the last commit. Runs post-commit, so the
      // pane exists. Meta/zoom/resize commits leave the id set unchanged (no fire).
      // The auto-spawn below commits re-entrantly, so its new leaf is caught here too.
      const currentIds = lath.store.leafIds();
      const prevIds = prevLeafIdsRef.current;
      let leavesChanged = currentIds.length !== prevIds.size;
      for (const id of currentIds) {
        if (!prevIds.has(id)) {
          leavesChanged = true;
          fireEvent({ type: 'paneAdded', id });
        }
      }
      // The size check also catches pure removals, purging dead ids so a later
      // re-add of the same id fires again.
      if (leavesChanged) prevLeafIdsRef.current = new Set(currentIds);
      if (snap.tree.root !== null) return;
      const id = generatePaneId();
      surfaceRefForId(id);
      const defaults = getDefaultShellOpts();
      if (defaults?.shell) setPendingShellOpts(id, { shell: defaults.shell, args: defaults.args });
      lath.store.setEnterHint(id, 'top-left'); // grows from the top-left as the killed pane shrank to the bottom-right
      lath.store.addLeaf(id, terminalLeafMeta(), null); // becomes the root
      // Adopt selection only when it points at nothing real: null, or dangling (a
      // just-killed pane). A live door (last pane minimized) keeps selection.
      const sel = selectedIdRef.current;
      const selDangling = sel !== null && selectedTypeRef.current === 'pane' && !lath.store.has(sel);
      if (sel === null || selDangling) selectPane(id);
    });
  }, [lath, generatePaneId, surfaceRefForId, selectPane, fireEvent]);

  // --- Session persistence ---
  useSessionPersistence({
    lath,
    doors,
    doorsRef,
    selectedIdRef,
    selectedTypeRef,
    surfaceRefsForSave,
  });

  // --- Dev-server port → pane correlation (browser header connection chip) ---
  useDevServerPortCorrelation({ lath, doorsRef });

  // --- Spoken alarms (`docs/specs/alert.md` -> Alarm settings) ---
  useAlertSpeech();

  // --- Reattach ---

  const handleReattach = useCallback((
    item: DooredItem,
    options?: { enterPassthrough?: boolean; afterRestore?: DoorAfterRestoreAction },
  ) => {
    const enterPassthrough = options?.enterPassthrough ?? true;
    const afterRestore = options?.afterRestore;

    // Restore through the core token (the real payload): exact tier when the
    // captured context survives, else neighbor, else fallback beside a live ref.
    // Every Door has store meta; the fallback keeps a reattach from being lost if
    // some future creation path forgets to register one.
    const meta = lath.getMeta(item.id) ?? terminalLeafMeta();
    const token = item.token as RestoreToken | undefined;
    // The enter hint (from the token's edge) is derived inside `restoreLeaf`.
    const sel = selectedIdRef.current;
    const fallbackRef = sel && selectedTypeRef.current === 'pane' && lath.store.has(sel)
      ? sel
      : lath.listPanes()[0]?.id;
    const r = token ? lath.store.restoreLeaf(meta, token, { fallbackRef }) : { ok: false };
    // No token (or no fallback was possible — empty tree): make the leaf the root.
    if (!r.ok) lath.store.addLeaf(item.id, meta, null);

    removeDoorAndSelect(item.id);
    if (enterPassthrough) {
      enterTerminalMode(item.id);
    } else {
      modeRef.current = 'command';
      setMode('command');
      requestAnimationFrame(() => {
        // Guard against removal between scheduling and execution.
        if (!nav.hasPane(item.id)) return;
        focusSession(item.id, false);
        if (afterRestore === 'kill-immediately') {
          killPaneImmediately(item.id);
        } else if (afterRestore === 'confirm-kill') {
          setConfirmKill({ id: item.id, char: randomKillChar() });
        } else if (typeof afterRestore === 'object' && afterRestore.type === 'replace-terminal') {
          // Atomic identity swap in place — no transient add/remove.
          lath.store.replaceLeaf(item.id, afterRestore.newId, terminalLeafMeta());
          disposeSession(item.id);
          forgetSurfaceRef(item.id);
          selectPane(afterRestore.newId);
          if (afterRestore.announce) {
            showShellSpawnNotice(afterRestore.newId, `Switched to ${afterRestore.shellName}`);
          }
        }
      });
    }
  }, [selectPane, removeDoorAndSelect, enterTerminalMode, killPaneImmediately, forgetSurfaceRef, showShellSpawnNotice, lath, nav]);
  const handleReattachRef = useRef(handleReattach);
  handleReattachRef.current = handleReattach;

  /** Focus a surface for the human half of `connectPort`: activating a port row
   *  is an explicit request to look at and control that browser. A visible pane
   *  enters passthrough in place; a minimized one reattaches on the same terms
   *  as clicking its Door chip. This is deliberately unlike `dor ab`, whose
   *  agent-initiated control path remains focus-neutral. */
  const revealSurface = useCallback((id: string) => {
    if (nav.hasPane(id)) {
      enterTerminalMode(id);
      return;
    }
    const door = doorsRef.current.find((item) => item.id === id);
    if (door) handleReattachRef.current(door);
  }, [nav, enterTerminalMode]);

  // The Surfaces of the current Workspace. `buildDorSurfaces` is the visible-pane
  // projection used for geometry/placement; `buildDorSurfaceList` additionally
  // includes minimized (doored) Surfaces for `dor list` and direct operations.
  // `surface:N` refs come from the Workspace-scoped registry above, not from
  // layout/list position. This is a parallel projection to the phone's
  // `DirectoryEntry` (`lib/src/remote/host/directory-collect.ts`) over the same
  // stores — keep the shared field derivations (activity / cwd / ringing / todo)
  // in sync.
  const buildDorSurfacesInternal = useCallback((includeMinimized: boolean): DorSurface[] => {
    const panels = lath.listPanes();
    const doors = includeMinimized ? doorsRef.current : [];
    const activeId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
    const zoomedId = lath.store.getSnapshot().zoomedId;
    const terminalStates = getTerminalPaneStateSnapshot();
    const activityStates = getActivitySnapshot();
    const appTitleForPane = buildAppTitleResolver(terminalStates, activityStates);

    const sources = [
      ...panels.map((panel) => ({ id: panel.id, params: panel.params, title: panel.title, minimized: false })),
      ...doors.map((door) => {
        const meta = lath.getMeta(door.id);
        return { id: door.id, params: meta?.params, title: meta?.title, minimized: true };
      }),
    ];
    const states = sources.map((source) => terminalStates.get(source.id) ?? createTerminalPaneState());

    return sources.map((source, index) => {
      const kind = surfaceKindFromParams(source.params);
      // Row fields are capability-gated, not kind-gated (docs/specs/glossary.md
      // → Panes and Surfaces): shell state rides the terminal, the URL rides the
      // browser, so a future kind that has both populates both without touching
      // this map.
      const terminalBacked = hasTerminal(kind);
      const renderMode = surfaceRenderModeFromParams(source.params);
      const state = states[index];
      const activity = activityStates.get(source.id);
      const shellActivity = terminalBacked ? state.activity : null;
      const title = terminalBacked
        ? deriveSurfaceLabel(state, states, appTitleForPane, source.title ?? source.id)
        : (source.title ?? source.id);
      const view: DorSurfaceView = source.minimized
        ? 'minimized'
        : (source.id === zoomedId ? 'zoomed' : 'paned');

      return {
        id: source.id,
        ref: surfaceRefForId(source.id),
        kind,
        renderMode,
        title,
        focused: source.id === activeId,
        view,
        cwd: terminalBacked ? (state.cwd?.path ?? null) : null,
        activity: shellActivity ? shellActivity.kind : null,
        ...(shellActivity?.kind === 'finished' && shellActivity.exitCode !== undefined
          ? { exitCode: shellActivity.exitCode }
          : {}),
        command: terminalBacked ? (state.currentCommand?.displayCommand ?? null) : null,
        url: hasBrowser(kind) ? browserUrlFromParams(source.params) : null,
        ringing: activity?.status === 'ALERT_RINGING',
        todo: activity?.todo === true,
        awaited: activity?.awaited === true,
      };
    });
  }, [lath, surfaceRefForId]);

  const buildDorSurfaces = useCallback(
    (): DorSurface[] => buildDorSurfacesInternal(false),
    [buildDorSurfacesInternal],
  );
  const buildDorSurfaceList = useCallback(
    // buildDorSurfacesInternal already returns a fresh array, so sort it in place.
    (): DorSurface[] => buildDorSurfacesInternal(true).sort(compareBySurfaceRef),
    [buildDorSurfacesInternal],
  );

  const createSplitSurface = useCallback(({
    command,
    direction,
    minimized,
    reference,
    cwd,
    requireIntegration,
    focusNeutral,
    leafMeta,
    deferTerminal,
  }: {
    command?: string;
    direction: DorResolvedSplitDirection;
    minimized: boolean;
    reference: DorSurface;
    cwd?: string;
    requireIntegration?: boolean;
    /** Leaf metadata for the new Surface; defaults to a plain terminal. `dor
     *  tool` passes a tool leaf, which is a shell-hosted PTY exactly like a
     *  terminal but renders both capabilities. */
    leafMeta?: LeafMeta;
    // `dor ensure` and `dor split -- <command>` must never move focus: the split
    // is created in the background, leaving the caller's selection, mode, and DOM
    // focus intact. Under Lath every add is inherently background (nothing
    // re-parents or activates).
    focusNeutral?: boolean;
    /** Create the leaf but stage no shell and spawn no PTY. `dor tool` uses it
     *  for a pane awaiting approval: nothing from the repo may run until a human
     *  chooses (docs/specs/dor-tool.md -> Trust rule 3). */
    deferTerminal?: boolean;
  }): ParseResult<{
    id: string;
    ref: string;
    minimized: boolean;
  }> => {
    const referenceId = reference.id;
    const referenceVisible = nav.hasPane(referenceId);
    const referenceDoor = !referenceVisible
      ? doorsRef.current.find((door) => door.id === referenceId)
      : undefined;
    if (!referenceVisible && !referenceDoor) {
      return { ok: false, message: `surface '${reference.ref}' is not in the active workspace` };
    }

    const newId = generatePaneId();
    const defaults = getDefaultShellOpts();
    // An explicit cwd (dor ensure --cwd, defaulting to the caller's directory)
    // wins; otherwise inherit the reference pane's local cwd as dor split does.
    const sourceCwd = getTerminalPaneState(referenceId).cwd;
    const inheritedCwd = cwd ?? (sourceCwd && !sourceCwd.isRemote ? sourceCwd.path : undefined);

    if (deferTerminal) {
      // No pending shell opts at all: the terminal must not spawn when the leaf
      // mounts, and must not inherit a cwd it will never use.
    } else if (command) {
      // Spawn a real interactive shell and type the command into it once it
      // reaches a prompt (see typeCommandWhenPromptReady in the lifecycle), rather
      // than launching `shell -c command`. A `-c` invocation has no prompt behind
      // it: the command *is* the shell's whole job, so `dor ensure --restart`'s
      // Ctrl+C would interrupt the command and take the shell down with it (the
      // pty exits) instead of returning to a prompt the command can be re-run at.
      setPendingShellOpts(newId, {
        shell: defaults?.shell,
        args: defaults?.args,
        cwd: inheritedCwd,
        // Starting the command is Dormouse orchestration, not user input. A
        // tool stays untouched until its terminal or browser receives input;
        // other commanded splits retain their established conservative state.
        untouched: leafMeta?.component === 'tool',
        command,
        ...(requireIntegration ? { requireIntegration: true } : {}),
      });
    } else if (defaults?.shell || inheritedCwd) {
      setPendingShellOpts(newId, {
        shell: defaults?.shell,
        args: defaults?.args,
        cwd: inheritedCwd,
      });
    }

    if (referenceDoor) {
      const edge = edgeForDorDirection(direction);
      const ref = surfaceRefForId(newId);
      const token: RestoreToken = {
        leafId: newId,
        weight: 0.5,
        siblingId: referenceId,
        siblingLeafIds: [referenceId],
        edge,
        index: direction === 'left' || direction === 'up' ? 0 : 1,
        fingerprint: null,
      };
      if (!deferTerminal) getOrCreateTerminal(newId);
      // This Surface is born minimized — it never has a pane to detach — so register
      // its meta directly, keeping the store the authority for EVERY Door
      // (docs/specs/tiling-engine.md → "Parked leaves").
      lath.store.addDoor(newId, leafMeta ?? terminalLeafMeta());
      addMinimizedSplitDoor(referenceId, { id: newId, token }, !focusNeutral);
      onEventRef.current?.({
        type: 'split',
        direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
        source: 'dor',
      });
      return { ok: true, value: { id: newId, ref, minimized: true } };
    }

    // The split is inherently background: `dor split` (not focus-neutral) selects
    // the new pane — in passthrough mode selection carries DOM focus, so the user
    // types straight into it; `dor split -- <command>` and `dor ensure`
    // (focus-neutral) leave selection put.
    const edge = edgeForDorDirection(direction);
    lath.store.addLeaf(newId, leafMeta ?? terminalLeafMeta(), { refId: referenceId, edge });
    const selectedNew = settleAddSelection(!!focusNeutral, false, newId);
    onEventRef.current?.({
      type: 'split',
      direction: direction === 'left' || direction === 'right' ? 'horizontal' : 'vertical',
      source: 'dor',
    });
    if (minimized) {
      if (!deferTerminal) getOrCreateTerminal(newId);
      minimizePane(newId, { select: selectedNew });
    }
    return { ok: true, value: { id: newId, ref: surfaceRefForId(newId), minimized } };
  }, [addMinimizedSplitDoor, generatePaneId, minimizePane, surfaceRefForId, lath, settleAddSelection, nav]);

  /**
   * Create a non-terminal content surface (iframe, agent-browser) next to a
   * reference surface: an untouched terminal caller is replaced in place,
   * anything else gets a split (the `dor iframe` placement rule).
   */
  const createContentSurface = useCallback(({
    minimized,
    params,
    reference,
    title,
    focusNeutral,
  }: {
    minimized: boolean;
    params: Record<string, unknown>;
    reference: DorSurface;
    title: string;
    // `dor iframe` / `dor ab` pass this to open the surface in the background
    // without moving focus off the caller, matching `dor ensure`.
    focusNeutral?: boolean;
  }): ParseResult<{
    id: string;
    ref: string;
    status: 'created' | 'replaced';
  }> => {
    const referenceVisible = nav.hasPane(reference.id);
    if (!referenceVisible) return { ok: false, message: `surface '${reference.ref}' is not visible` };

    const newId = generatePaneId();
    const browserMeta = browserLeafMeta(title, params);
    // Replace-in-place is reserved for a reference with no browser — a blank
    // untouched shell. Anything holding web content (a browser surface today, a
    // tool that has both later) must split beside it instead of being destroyed.
    const replaceUntouchedShell = !hasBrowser(reference.kind) && isUntouched(reference.id);

    if (replaceUntouchedShell) {
      // Whether the user's current selection sits on the pane being replaced.
      const selectionReplaced = selectedTypeRef.current === 'pane' && selectedIdRef.current === reference.id;
      // Atomic identity swap in place; then dispose the old terminal session.
      const ref = transferSurfaceRef(reference.id, newId);
      lath.store.replaceLeaf(reference.id, newId, browserMeta);
      disposeSession(reference.id);
      // Replacing the pane the user is selected on forces selection onto the
      // replacement; replacing any other pane leaves the user's selection —
      // including a door selection — untouched.
      const selectedNew = settleAddSelection(!!focusNeutral, selectionReplaced, newId);
      // When we did move selection onto the new pane, a minimize must carry it
      // onto the resulting door rather than leave selectedType='pane' pointing
      // at a door id (the overlay would keep a stale rect).
      if (minimized) minimizePane(newId, { select: selectedNew });
      return { ok: true, value: { id: newId, ref, status: 'replaced' } };
    }

    // Split beside the reference by its aspect ratio (autoEdge). The split-event
    // direction derives from it.
    const lathEdge = lath.store.autoEdgeFor(reference.id);
    const horizontal = lathEdge === 'right';
    lath.store.addLeaf(newId, browserMeta, { refId: reference.id, edge: lathEdge });
    const selectedNew = settleAddSelection(!!focusNeutral, false, newId);
    onEventRef.current?.({
      type: 'split',
      direction: horizontal ? 'horizontal' : 'vertical',
      source: 'dor',
    });
    if (minimized) minimizePane(newId, { select: selectedNew });
    return { ok: true, value: { id: newId, ref: surfaceRefForId(newId), status: 'created' } };
  }, [generatePaneId, minimizePane, surfaceRefForId, transferSurfaceRef, lath, settleAddSelection, nav]);

  // The last binary path a `dor ab` surface resolved on a terminal's PATH.
  // Re-used to spawn an agent-browser when swapping an iframe embed up to a
  // screencast, since the webview/host PATH may not find the binary itself.
  const lastAgentBrowserBinaryPathRef = useRef<string | undefined>(undefined);

  /**
   * Replace a content surface's renderer in place, preserving its slot
   * (docs/specs/dor-browser.md → "Display Modal And Render Swaps"): an atomic
   * identity swap that closes the old surface's session if any and selects the new.
   * The generalized form of createContentSurface's replace-untouched-terminal branch.
   */
  const replaceSurface = useCallback((oldId: string, next: {
    params: Record<string, unknown>;
    title: string;
  }): string | null => {
    const oldParams = nav.paneParams(oldId);
    const oldVisible = nav.hasPane(oldId);
    if (!oldVisible) return null;
    closeAgentBrowserSession(oldParams);
    // The old renderer's controller is going away with this swap; release its
    // client-side resources (no-op for a non-agent-browser surface).
    disposeAgentBrowserSurfaceController(oldId);
    const newId = generatePaneId();
    transferSurfaceRef(oldId, newId);
    lath.store.replaceLeaf(oldId, newId, browserLeafMeta(next.title, next.params));
    clearLocalSurfaceActivity(oldId);
    selectPane(newId);
    return newId;
  }, [generatePaneId, transferSurfaceRef, selectPane, lath, nav]);

  // Listen for external "new terminal" requests (e.g. from the standalone AppBar)
  useEffect(() => {
    const handler = (e: Event) => {
      const detail = ((e as CustomEvent<ShellSpawnRequest>).detail ?? {}) as ShellSpawnRequest;
      const newId = generatePaneId();
      surfaceRefForId(newId);

      // Store shell options so getOrCreateTerminal picks them up on mount
      if (detail?.shell) {
        setPendingShellOpts(newId, { shell: detail.shell, args: detail.args });
      }

      const selectedPaneId = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      const selectedPaneVisible = !!selectedPaneId && nav.hasPane(selectedPaneId);
      const selectedDoor = selectedTypeRef.current === 'door'
        ? doorsRef.current.find((door) => door.id === selectedIdRef.current)
        : undefined;
      const shouldReplaceUntouched =
        detail.replaceUntouched === true &&
        selectedPaneVisible &&
        !isToolParams(lath.getMeta(selectedPaneId!)?.params) &&
        isUntouched(selectedPaneId!);
      const shellName = detail.name?.trim() || 'terminal';

      if (shouldReplaceUntouched) {
        lath.store.replaceLeaf(selectedPaneId!, newId, terminalLeafMeta());
        disposeSession(selectedPaneId!);
        forgetSurfaceRef(selectedPaneId!);
        selectPane(newId);
        if (detail.announce) {
          showShellSpawnNotice(newId, `Switched to ${shellName}`);
        }
        return;
      }

      if (
        detail.replaceUntouched === true &&
        selectedDoor &&
        !isToolParams(lath.getMeta(selectedDoor.id)?.params) &&
        isUntouched(selectedDoor.id)
      ) {
        handleReattachRef.current(selectedDoor, {
          enterPassthrough: false,
          afterRestore: {
            type: 'replace-terminal',
            newId,
            shellName,
            announce: detail.announce === true,
          },
        });
        return;
      }

      // Split beside the selected pane when it's a live pane, else `null` lets the
      // store fall back to the last leaf via autoEdge (its null-position behavior).
      const edge = selectedPaneVisible ? lath.store.autoEdgeFor(selectedPaneId!) : null;
      // The enter hint is derived inside `addLeaf` from the edge it commits.
      lath.store.addLeaf(newId, terminalLeafMeta(), edge ? { refId: selectedPaneId!, edge } : null);
      // A host New Terminal action is an interactive spawn: put the user straight
      // into the new shell. Replacement paths above preserve their existing mode.
      enterTerminalMode(newId);
      if (detail.announce) {
        showShellSpawnNotice(newId, `Opened ${shellName}`);
      }
    };
    window.addEventListener('dormouse:new-terminal', handler);
    return () => window.removeEventListener('dormouse:new-terminal', handler);
  }, [generatePaneId, surfaceRefForId, forgetSurfaceRef, selectPane, enterTerminalMode, showShellSpawnNotice, lath, nav]);

  // --- dor control plane (the `dor` CLI's webview handler) ---
  // Approving a pending tool: record the grant, then start the command in the
  // pane that has been showing the prompt. The two steps are ordered so a
  // failed write never leaves a running command in an unapproved repo.
  const resolveToolApproval = useCallback(async (id: string, choice: 'upstream' | 'folder' | 'decline') => {
    const meta = lath.getMeta(id);
    const pending = toolPendingFromParams(meta?.params);
    if (!pending) return;
    if (choice === 'decline') {
      // A refusal writes nothing: it closes the pane and leaves no record, so a
      // reflexive decline cannot permanently disable tools for this repo.
      killPaneImmediately(id);
      return;
    }
    if (toolApprovalsInFlightRef.current.has(id)) return;
    toolApprovalsInFlightRef.current.add(id);

    try {
      const platform = getPlatform();
      await platform.toolControl?.({
        op: 'trust',
        kind: choice,
        projectRoot: pending.projectRoot,
        upstreamUrl: pending.upstreamUrl,
      });

      // Re-resolve now that the grant exists. The untrusted lookup deliberately
      // withholds `render` / `port` / `key` — they live only in the `ok` arm — so
      // asking again is what gives an approved tool the config its dormouse.yml
      // declared, rather than silently running it as a keyless default iframe.
      const cwd = typeof meta?.params?.cwd === 'string' ? meta.params.cwd : pending.projectRoot;
      const resolved = await platform.toolControl?.({ op: 'lookup', name: pending.name, cwd });
      if (resolved?.status !== 'ok') {
        killPaneImmediately(id);
        return;
      }

      lath.store.updateParams(id, {
        command: resolved.run,
        toolRender: resolved.render,
        toolPort: resolved.port,
        ...(resolved.key ? { toolKey: namespacedToolKey(resolved.name, resolved.key) } : {}),
      });
      // Hand the leaf its command only now. The approval marker stays in place
      // until after this write, so TerminalPanel cannot consume default options
      // while the host calls above are pending.
      const defaults = getDefaultShellOpts();
      setPendingShellOpts(id, {
        shell: defaults?.shell,
        args: defaults?.args,
        cwd,
        untouched: true,
        command: resolved.run,
        requireIntegration: true,
      });
      lath.store.updateParams(id, { toolPending: undefined });
      // The launch asked for this, and it was withheld so the prompt could be seen.
      if (pending.minimized) {
        // Minimizing detaches the leaf before it can mount, so the PTY that
        // consumes the staged opts has to be created here — the same reason
        // `createSplitSurface` spawns before `addDoor` / `minimizePane`.
        getOrCreateTerminal(id);
        minimizePane(id);
      }
    } finally {
      toolApprovalsInFlightRef.current.delete(id);
    }
  }, [lath, killPaneImmediately, minimizePane]);

  // A tool grows its browser when its command starts serving.
  useToolServing({ lath, doorsRef });

  const { connectPort } = useDorControl({
    lath,
    nav,
    doorsRef,
    buildDorSurfaces,
    buildDorSurfaceList,
    surfaceRefForId,
    createSplitSurface,
    createContentSurface,
    killPaneImmediately,
    revealSurface,
    lastAgentBrowserBinaryPathRef,
  });

  const addSplitPanel = useCallback((
    id: string | null,
    direction: 'right' | 'below',
    splitDirection: 'horizontal' | 'vertical',
    source: 'keyboard' | 'mouse' = 'mouse',
  ) => {
    const newId = generatePaneId();
    surfaceRefForId(newId);
    const ref = id && nav.hasPane(id) ? id : null;
    // Carry the currently selected shell into every manual split.
    const defaults = getDefaultShellOpts();
    // Remote cwds (OSC 7 over ssh) name a path on the remote host, not one the local shell can chdir to.
    const sourceCwd = ref ? getTerminalPaneState(ref).cwd : null;
    const inheritedCwd = sourceCwd && !sourceCwd.isRemote ? sourceCwd.path : undefined;
    if (defaults?.shell || inheritedCwd) {
      setPendingShellOpts(newId, { shell: defaults?.shell, args: defaults?.args, cwd: inheritedCwd });
    }
    const panes = lath.listPanes();
    const refId = ref ?? (panes.length > 0 ? panes[panes.length - 1].id : null);
    const edge: Edge = direction === 'right' ? 'right' : 'bottom';
    // The enter hint is derived inside `addLeaf` from the edge it commits.
    lath.store.addLeaf(newId, terminalLeafMeta(), refId ? { refId, edge } : null);
    // Manual split is an intent to use the new terminal: select it, enter
    // passthrough, and defer DOM focus through the shared focus path.
    enterTerminalMode(newId);
    onEventRef.current?.({ type: 'split', direction: splitDirection, source });
  }, [enterTerminalMode, generatePaneId, surfaceRefForId, lath, nav]);

  // --- Wall actions (for tab buttons) ---

  const wallActions: WallActions = useMemo(() => ({
    onKill: (id: string) => {
      exitTerminalMode();
      // `untouched` makes a blank terminal disposable. A tool can already own
      // a long-running command and browser resources before its first human
      // input, so it always takes the conservative confirmation path.
      if (isUntouched(id) && !isToolParams(lath.getMeta(id)?.params)) {
        killPaneImmediately(id);
        return;
      }
      const char = randomKillChar();
      setConfirmKill({ id, char });
    },
    onAlertButton: (id: string, displayedStatus: SessionStatus) => {
      return dismissOrToggleAlert(id, displayedStatus);
    },
    onToggleTodo: (id: string) => {
      toggleSessionTodo(id);
    },
    onMinimize: (id: string) => {
      minimizePane(id);
    },
    onSplitH: (id: string | null, source: 'keyboard' | 'mouse' = 'mouse') => {
      addSplitPanel(id, 'right', 'horizontal', source);
    },
    onSplitV: (id: string | null, source: 'keyboard' | 'mouse' = 'mouse') => {
      addSplitPanel(id, 'below', 'vertical', source);
    },
    onZoom: (id: string) => {
      if (!nav.hasPane(id)) return;
      // Zoom belongs to focus: only the owner's control toggles zoom off. Another
      // pane's Zoom control means "zoom me" — the elevated pane exposes a
      // perimeter, so a partially covered header is reachable and must hand zoom
      // over rather than merely unzoom the owner. Acquiring zoom first enters
      // passthrough on this pane (unless it already owns focus); selectPane's
      // `releaseZoomExcept` drops the previous owner on the way through.
      const currentZoom = lath.store.getSnapshot().zoomedId;
      if (currentZoom === id) {
        lath.store.setZoomed(null);
        return;
      }
      if (
        modeRef.current !== 'passthrough' ||
        selectedTypeRef.current !== 'pane' ||
        selectedIdRef.current !== id
      ) {
        enterTerminalMode(id);
      }
      lath.store.setZoomed(id);
    },
    onClickPanel: (id: string) => {
      setConfirmKill(null);
      enterTerminalMode(id);
    },
    onFocusPane: (id: string) => {
      setConfirmKill(null);
      // Visible pane → jump straight in; minimized (a door) → reattach first.
      const visible = nav.hasPane(id);
      if (visible) {
        enterTerminalMode(id);
        return;
      }
      const door = doorsRef.current.find((item) => item.id === id);
      if (door) handleReattachRef.current(door, { enterPassthrough: true });
    },
    onStartRename: (id: string) => {
      setRenamingPaneId(id);
    },
    onFinishRename: (id: string, value: string) => {
      const trimmed = value.trim();
      if (!trimmed) {
        setRenamingPaneId(null);
        return { accepted: false, reason: 'empty' as const };
      }
      const result = setTerminalUserTitle(id, trimmed);
      if (result.accepted) {
        lath.store.setTitle(id, trimmed);
      }
      setRenamingPaneId(null);
      return result;
    },
    onCancelRename: () => {
      setRenamingPaneId(null);
    },
    onSwapRenderMode: (id, mode) => {
      const visible = nav.hasPane(id);
      if (!visible) return;
      const params = nav.paneParams(id);
      const currentRenderMode = surfaceRenderModeFromParams(params);

      // A tool's browser is a param of the tool's own leaf, so a swap mutates
      // `renderMode` in place and never routes through `replaceSurface`
      // (docs/specs/dor-tool.md -> The tool capability set). Replacing would
      // mint a new id, drop the terminal half and the tool's identity, and
      // orphan the PTY still running the command. iframe ⇄ ab-* is a re-open of
      // the same URL, which the serving trigger performs on the next tick.
      if (isToolParams(params)) {
        if (mode === currentRenderMode) return;
        // Swapping away from an ab-rendered tool still has to release the
        // session and the controller — `replaceSurface` does both on the
        // non-tool path, and this branch skips it by design. Once `session` is
        // gone from params nothing can reach the daemon again, not even a kill.
        closeAgentBrowserSession(params);
        disposeAgentBrowserSurfaceController(id);
        lath.store.updateParams(id, {
          toolRender: mode === 'iframe' ? 'iframe' : 'ab-screencast',
          // Drop the browser so `useToolServing` re-derives it under the new
          // renderer; the URL is re-derived from the scan, never carried over.
          renderMode: undefined,
          url: undefined,
          session: undefined,
          wsPort: undefined,
        });
        return;
      }

      // agent-browser → iframe: frame the active tab's URL, then the replace
      // closes the now-unneeded headless browser. Webview-only.
      if ((currentRenderMode === 'ab-screencast' || currentRenderMode === 'ab-popout') && mode === 'iframe') {
        // Canonical params.url (mirrored from the chrome snapshot) first; fall
        // back to the live snapshot for a surface that hasn't reported a tab yet.
        const url = (typeof params?.url === 'string' && params.url) || getAgentBrowserScreenController(id)?.chrome().url;
        if (!url) return;
        replaceSurface(id, {
          params: { surfaceType: 'browser', renderMode: 'iframe', url },
          title: hostPathDisplay(url, true),
        });
        return;
      }

      // iframe → live agent-browser (ab-screencast or ab-popout): the host must
      // spawn a session for the URL (absent ⇒ inert, like other host-gated
      // affordances). ab-popout spawns headed directly so the new surface mounts
      // already popped-out (no headless launch + immediate relaunch flash).
      if (currentRenderMode === 'iframe' && (mode === 'ab-screencast' || mode === 'ab-popout')) {
        const chromeUrl = getAgentBrowserScreenController(id)?.chrome().url;
        const url = (typeof chromeUrl === 'string' && chromeUrl)
          || (typeof params?.url === 'string' ? params.url : undefined);
        const platform = getPlatform();
        if (!url || !platform.agentBrowserOpen) return;
        const headed = mode === 'ab-popout';
        platform.agentBrowserOpen(url, { headed }, lastAgentBrowserBinaryPathRef.current).then((res) => {
          if (!res.ok || !res.session) return;
          if (res.binaryPath) lastAgentBrowserBinaryPathRef.current = res.binaryPath;
          const nextParams = {
            surfaceType: 'browser',
            renderMode: mode,
            session: res.session,
            url,
            ...(res.wsPort !== undefined ? { wsPort: res.wsPort } : {}),
            ...(res.binaryPath !== undefined ? { binaryPath: res.binaryPath } : {}),
            syncEngaged: true,
          };
          const nextId = replaceSurface(id, {
            params: nextParams,
            title: hostPathDisplay(url, true),
          });
          if (!nextId) {
            closeAgentBrowserSession(nextParams);
            console.warn(`[dormouse] failed to replace iframe surface '${id}' with agent-browser surface`);
          }
        }).catch((err) => {
          console.warn('[dormouse] failed to swap iframe surface to agent-browser:', err);
        });
      }
    },
    onOpenBrowserPane: (id, url) => {
      // A new-tab request from the iframe shim → open the URL as a new iframe
      // browser pane, split next to the source (docs/specs/dor-browser.md →
      // "Iframe Shim").
      const reference = buildDorSurfaces().find((s) => s.id === id);
      if (!reference) return;
      createContentSurface({
        minimized: false,
        params: { surfaceType: 'browser', renderMode: 'iframe', url },
        reference,
        title: hostPathDisplay(url, true),
      });
    },
    resolveSurfaceRef: surfaceRefForId,
    // The pane context menu's "connect a port" action: act like `dor ab open`.
    onConnectPort: connectPort,
    // Pin the terminal forward past serving, or release it. Visibility only —
    // ToolPanel keeps both halves mounted (docs/specs/dor-tool.md).
    onResolveToolApproval: (id: string, choice: 'upstream' | 'folder' | 'decline') => {
      void resolveToolApproval(id, choice);
    },
    onToggleToolTerminal: (id: string) => {
      const showing = lath.getMeta(id)?.params?.showTerminal === true;
      lath.store.updateParams(id, { showTerminal: showing ? undefined : true });
    },
  }), [addSplitPanel, minimizePane, enterTerminalMode, exitTerminalMode, killPaneImmediately, replaceSurface, buildDorSurfaces, createContentSurface, surfaceRefForId, connectPort, resolveToolApproval, lath, nav]);
  const wallActionsRef = useRef(wallActions);
  wallActionsRef.current = wallActions;

  // Engine-directed writes for the pane props contract (docs/specs/tiling-engine.md
  // → "Pane props contract"): route a pane/header's title / params writes to the
  // engine's per-leaf metadata. Memoized so the sink handed to panels via context
  // keeps a stable identity. The render-swap and wsPort-refresh param writes in
  // Wall.tsx above route through the same engine.
  const paneWrite = useMemo<PaneWriteActions>(() => ({
    setTitle: (id, title) => lath.store.setTitle(id, title),
    updateParams: (id, patch) => lath.store.updateParams(id, patch),
  }), [lath]);

  useWallKeyboard({
    nav,
    swapWithNeighbor,
    modeRef,
    selectedIdRef,
    selectedTypeRef,
    doorsRef,
    confirmKillRef,
    renamingRef,
    dialogKeyboardActiveRef,
    wallActionsRef,
    handleReattachRef,
    selectPane,
    selectDoor,
    enterTerminalMode,
    exitTerminalMode,
    minimizePane,
    killPaneImmediately,
    acceptKill,
    rejectKill,
    setConfirmKill,
    setRenamingPaneId,
    fireEvent,
  });

  // LathHost surfaces `focusin` inside a leaf as an op proposal (embed self-focus
  // adoption, acceptance row 8): passthrough → enter the leaf if selection differs;
  // command → move selection onto it.
  const onLeafFocused = useCallback((id: string) => {
    if (modeRef.current === 'passthrough') {
      if (selectedIdRef.current !== id) enterTerminalMode(id);
      return;
    }
    if (selectedTypeRef.current !== 'pane' || selectedIdRef.current !== id) selectPane(id);
  }, [enterTerminalMode, selectPane]);

  // Stable so LathHost's sash-drag effect never re-subscribes on a Wall re-render.
  const onCommitResize = useCallback((splitPath: number[], boundary: number, deltaPx: number) => {
    lath.store.resizeBoundary(splitPath, boundary, deltaPx);
  }, [lath]);

  // --- Pane / Door drag-and-drop (docs/specs/tiling-engine.md → "Hierarchical drag
  // and drop"). LathHost owns the gesture and hit-testing; the Wall owns the op
  // commit + selection policy. ---

  // A pane drag crossed its threshold: move selection onto the dragged pane (covers
  // "dragging while a door is selected moves selection onto the dragged pane").
  // `selectPane` is idempotent, so no pre-check is needed — a plain header press already
  // selected it, and re-selecting is a no-op. Passed to LathHost's `onDragStart` directly.

  // Drop of a pane onto a hit-tested target: commit the move (command mode unchanged),
  // then select it. A center-drop swap mirrors the Cmd-Arrow swap's `move` event so
  // tutorial/event consumers behave identically.
  const onProposeMove = useCallback((id: string, target: DropTarget) => {
    const r = lath.store.moveLeaf(id, target);
    if (!r.ok) return;
    if (target.kind === 'swap') fireEvent({ type: 'move', fromId: id, toId: target.leaf });
    selectPane(id);
  }, [lath, fireEvent, selectPane]);

  // Drop of a pane onto the baseboard zone: minimize it (captures the token + selects
  // the door, exactly like the header minimize button). No-op when the Baseboard is
  // hidden — there is nowhere for a below-wall release to minimize into.
  const onProposeMinimize = useCallback((id: string) => {
    if (!showBaseboard) return;
    minimizePane(id);
  }, [minimizePane, showBaseboard]);

  // A Door received a press in the baseboard — hand its item + press point to LathHost,
  // which starts an inactive external drag and applies the threshold.
  const onDoorDragStart = useCallback((item: DooredItem, press: { clientX: number; clientY: number }) => {
    setDoorDrag({ item, startX: press.clientX, startY: press.clientY });
  }, []);

  // Drop of a dragged-out Door: `null` (sub-threshold press, cancel, or no candidate)
  // clears the transient drag and leaves the Door where it is; a target reattaches the
  // surface at the hit-tested position. The token is NOT consulted — the user chose the
  // spot. The enter hint (from the target edge) is derived inside `insertLeaf`.
  const onExternalDrop = useCallback((target: DropTarget | null) => {
    const dd = doorDrag;
    setDoorDrag(null);
    if (!dd || !target) return;
    const item = dd.item;
    // Every Door has store meta (minimize retains it, `addDoor` registers a
    // born-minimized one, `seed` restores it); the fallback matches `handleReattach`
    // so a drop can never be silently swallowed.
    const meta = lath.getMeta(item.id) ?? terminalLeafMeta();
    const r = lath.store.insertLeaf(item.id, meta, target);
    if (!r.ok) return; // insert failed (unexpected) → the Door stays put
    removeDoorAndSelect(item.id);
  }, [doorDrag, lath, removeDoorAndSelect]);

  // --- Render ---

  return (
    <ModeContext.Provider value={mode}>
      <SelectedIdContext.Provider value={selectedId}>
        <WallActionsContext.Provider value={wallActions}>
          <PaneWriteContext.Provider value={paneWrite}>
          <PaneElementsContext.Provider value={paneElementsContextValue}>
          <DoorElementsContext.Provider value={doorElementsContextValue}>
          <RenamingIdContext.Provider value={renamingPaneId}>
          <ZoomedIdContext.Provider value={zoomedId}>
          <WindowFocusedContext.Provider value={windowFocused}>
          <DialogKeyboardContext.Provider value={setDialogKeyboardActive}>
          <div className="flex-1 min-h-0 flex flex-col bg-app-bg text-app-fg font-sans overflow-hidden">
            {/* The tiling area — 2px bottom inset keeps rounded panes distinct from the baseboard when present. */}
            {/* 1.75 = PANE_GUTTER_PX (7px) in design.tsx — keep in sync. */}
            <div className={clsx('flex-1 min-h-0 relative px-1.75 pt-1.75', showBaseboard ? 'pb-0.5' : 'pb-1.75')}>
              <div className={clsx('absolute inset-x-1.75 top-1.75', showBaseboard ? 'bottom-0.5' : 'bottom-1.75')}>
                <LathHost
                  lath={lath}
                  onCommitResize={onCommitResize}
                  onLeafFocused={onLeafFocused}
                  onDragStart={selectPane}
                  onProposeMove={onProposeMove}
                  onProposeMinimize={onProposeMinimize}
                  externalDrag={doorDrag ? { id: doorDrag.item.id, startX: doorDrag.startX, startY: doorDrag.startY } : null}
                  onExternalDrop={onExternalDrop}
                />
                <WorkspaceSelectionOverlay lathStore={lath.store} subscribeLathFrames={lath.subscribeFrames} selectedId={selectedId} selectedType={selectedType} mode={mode} />
              </div>
            </div>

            {/* Baseboard — always visible in the main shell; embedders may suppress it for constrained mobile prototypes. */}
            {showBaseboard ? (
              <Baseboard
                items={doorChips}
                onReattach={handleReattach}
                notice={baseboardNotice}
                onDoorDragStart={onDoorDragStart}
              />
            ) : null}

            {/* Kill confirmation overlay — centered over the pane being killed */}
            {confirmKill && (
              <KillConfirmOverlay
                confirmKill={confirmKill}
                paneElements={paneElements}
                onCancel={() => rejectKill()}
              />
            )}

            <ShellSpawnNotice
              notice={shellSpawnNotice}
              paneElements={paneElements}
              version={paneElementsVersion}
            />

            <ExternalLinkModalHost onKeyboardActiveChange={setDialogKeyboardActive} />
            <AgentBrowserScreenModalHost
              onKeyboardActiveChange={setDialogKeyboardActive}
              resolveLabel={surfaceRefForId}
            />
            {enableRemoteHost ? (
              <Suspense fallback={null}>
                <RemotePairingModalHost onKeyboardActiveChange={setDialogKeyboardActive} />
              </Suspense>
            ) : null}
            {dialogHost}

          </div>
          </DialogKeyboardContext.Provider>
          </WindowFocusedContext.Provider>
          </ZoomedIdContext.Provider>
          </RenamingIdContext.Provider>
          </DoorElementsContext.Provider>
          </PaneElementsContext.Provider>
          </PaneWriteContext.Provider>
        </WallActionsContext.Provider>
      </SelectedIdContext.Provider>
    </ModeContext.Provider>
  );
}

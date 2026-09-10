import { useCallback, useEffect, useMemo, useRef, type RefObject } from 'react';
import { pasteFilePaths } from '../../lib/clipboard';
import { getPlatform } from '../../lib/platform';
import { saveSession, type SaveSink } from '../../lib/session-save';
import { createSessionDirtyTracker } from '../../lib/session-dirty';
import { publishWorkspaceSession } from '../../lib/window-session-aggregator';
import {
  subscribeToActivity,
  subscribeToTerminalPaneState,
  UNNAMED_PANEL_TITLE,
} from '../../lib/terminal-registry';
import { surfaceKindFromParams } from './browser-surface';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem, WallSelectionKind } from './wall-types';
import type { PersistedDoor, PersistedSession, PersistedSurfaceRefs, WorkspaceId } from '../../lib/session-types';

export interface SessionPersistenceHandle {
  /** Persist immediately, awaiting the whole queued pipeline. */
  flush: () => Promise<void>;
}

export function useSessionPersistence({
  lath,
  doors,
  doorsRef,
  selectedIdRef,
  selectedTypeRef,
  ownsSurface,
  surfaceRefsForSave,
  workspaceId,
}: {
  /** The Lath engine — the layout authority written on every commit, and the source
   *  of the visible-pane projection (`lath.listPanes()`). Stable identity, so the
   *  effect never re-subscribes. */
  lath: LathWallEngine;
  // The `doors` STATE value, not just `doorsRef`. Every door mutation now pairs with
  // a store commit (minimize `doorLeaf`, reattach `restoreLeaf`/`insertLeaf`, kill
  // `forgetLeaf`, born-minimized `addDoor`), so this is a correctness net rather than
  // the only signal — it keeps a future setDoors-only path from going unpersisted.
  doors: DooredItem[];
  doorsRef: RefObject<DooredItem[]>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
  /** Whether a Surface belongs to this Wall — panes AND Doors. The adapter fans
   *  every Session's traffic to every mounted Wall, so this is what keeps one
   *  Workspace from persisting on another's keystroke. Must be stable: the
   *  subscription effect closes over it. */
  ownsSurface: (id: string) => boolean;
  surfaceRefsForSave?: () => { refs: PersistedSurfaceRefs; next: number };
  /** Present when this Wall belongs to a Workspace: its record then goes to the
   *  Window collector instead of the platform slot, and is compared against its
   *  own Workspace's previous record. It also hands the host's flush request to
   *  `WorkspaceWindow`, which owns the one subscription for the whole Window —
   *  the adapter's first `notifySessionFlushComplete` wins, so N Walls answering
   *  would let a quit proceed after the first had written. */
  workspaceId?: WorkspaceId;
}): SessionPersistenceHandle {
  const ownsHostFlush = workspaceId === undefined;
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSavePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSaveNeededRef = useRef(false);
  // See session-dirty.ts for the conservative-under-races generation model.
  const trackerRef = useRef(createSessionDirtyTracker());
  // This Workspace's last published record: `getPreviousPaneMap`'s source, which
  // must be this Workspace's own (a dead PTY's cwd is retained there), not the
  // Window's active Workspace.
  const publishedRef = useRef<PersistedSession | null>(null);

  const sink = useMemo<SaveSink | undefined>(() => {
    if (workspaceId === undefined) return undefined;
    return {
      previous: () => publishedRef.current,
      publish: (session) => {
        publishedRef.current = session;
        publishWorkspaceSession(workspaceId, session);
      },
    };
  }, [workspaceId]);

  /** The pane + Door projection every save and serialization is built from. The
   *  runtime Door is id + token; its metadata is materialized HERE, from the
   *  store that owned it all along, so a Surface persists where it navigated to
   *  rather than where it was minimized and a restart cold-loads it there. */
  const collect = useCallback(() => {
    const panes = lath.listPanes().map((p) => ({
      id: p.id,
      title: p.title ?? UNNAMED_PANEL_TITLE,
      surfaceType: surfaceKindFromParams(p.params),
    }));
    const doors: PersistedDoor[] = (doorsRef.current ?? []).map((door) => {
      const meta = lath.getMeta(door.id);
      return {
        id: door.id,
        title: meta?.title?.trim() || UNNAMED_PANEL_TITLE,
        component: meta?.component,
        tabComponent: meta?.tabComponent,
        params: meta?.params,
        token: door.token,
      };
    });
    const surfaceRefs = surfaceRefsForSave?.();
    // The Lath tree is the sole persisted layout; doors ride through with their tokens.
    return { panes, doors, lathLayout: lath.serializeLayout(), surfaceRefs };
  }, [lath, doorsRef, surfaceRefsForSave]);

  const doSave = useCallback((): Promise<void> => {
    const { panes, doors, lathLayout, surfaceRefs } = collect();
    return saveSession(getPlatform(), panes, doors, lathLayout, surfaceRefs?.refs, surfaceRefs?.next, sink);
  }, [collect, sink]);

  const persistSessionNow = useCallback(async (): Promise<void> => {
    const runSave = (): Promise<void> => {
      pendingSaveNeededRef.current = false;
      // Clear dirty only on a fulfilled write (.then, not .finally).
      const token = trackerRef.current.beginSave();
      const savePromise = doSave()
        .then(() => {
          trackerRef.current.completeSave(token);
        })
        .finally(() => {
          if (sessionSavePromiseRef.current === savePromise) {
            sessionSavePromiseRef.current = pendingSaveNeededRef.current ? runSave() : null;
          }
        });
      sessionSavePromiseRef.current = savePromise;
      return savePromise;
    };

    if (sessionSavePromiseRef.current) {
      pendingSaveNeededRef.current = true;
    } else {
      runSave();
    }
    // Await until the pipeline idles so the resolution covers the LATEST queued
    // save, not just the one in flight. Swallow a per-save rejection here: a
    // failed save still chains its queued follow-up (via `.finally`), so
    // throwing out of the loop would abandon that follow-up and resolve before
    // the pipeline is actually idle. Terminates: a rerun chains only while a new
    // save was requested mid-save, so the chain is finite.
    while (sessionSavePromiseRef.current) {
      await sessionSavePromiseRef.current.catch(() => undefined);
    }
  }, [doSave]);

  // Belt and braces: the store commit that accompanies every door mutation already
  // schedules a save, so this only has to catch a setDoors that somehow stands alone.
  useEffect(() => {
    trackerRef.current.markDirty();
  }, [doors]);

  // Never gated on the dirty tracker — the correctness net for dirty-trigger
  // gaps (e.g. a program calling chdir() silently produces no event).
  const flushSessionSave = useCallback((): Promise<void> => {
    if (sessionSaveTimerRef.current) {
      clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    return persistSessionNow();
  }, [persistSessionNow]);

  const scheduleSessionSave = useCallback(() => {
    trackerRef.current.markDirty();
    if (sessionSaveTimerRef.current) return;
    sessionSaveTimerRef.current = setTimeout(() => {
      sessionSaveTimerRef.current = null;
      void persistSessionNow().catch(() => undefined);
    }, 500);
  }, [persistSessionNow]);

  useEffect(() => {
    const platform = getPlatform();
    const { markDirty, isDirty } = trackerRef.current;

    // Both PTY triggers are ownership-filtered over MEMBERS, panes and Doors
    // alike: a minimized Session's `untouched` flip rides the pty echo of the
    // keystroke, so filtering on visible panes would never persist it.
    const handlePtyData = (detail: { id: string }) => {
      if (ownsSurface(detail.id)) markDirty();
    };
    const handlePtyExit = (detail: { id: string }) => {
      if (!ownsSurface(detail.id)) return;
      void flushSessionSave().catch(() => undefined);
    };
    // Only a bare Wall answers the host directly; a Workspace Wall's answer is
    // `WorkspaceWindow`'s, which flushes every Workspace before notifying (the
    // adapter completes on the first notification).
    const handleSessionFlushRequest = (detail: { requestId: string }) => {
      void flushSessionSave()
        .catch(() => undefined)
        .finally(() => {
          platform.notifySessionFlushComplete(detail.requestId);
        });
    };
    const handlePageHide = () => {
      void flushSessionSave().catch(() => undefined);
    };

    // One subscription: every store commit (add/remove/resize/swap/meta, including
    // the active-pane the serialized layout records) schedules a save.
    const unsubscribeStore = lath.store.subscribe(scheduleSessionSave);

    // Content inputs mark dirty but never schedule — the heartbeat persists them
    // (docs/specs/layout.md → "Session persistence"). An untouched flip has no
    // store of its own to report it (the registry mutates silently), which is
    // why the pty echo above is what marks it.
    platform.onPtyData(handlePtyData);
    const unsubActivity = subscribeToActivity(markDirty);
    const unsubPaneState = subscribeToTerminalPaneState(markDirty);

    // Heartbeat: idle sessions no longer write (only when something marked dirty).
    const interval = setInterval(() => {
      if (isDirty()) scheduleSessionSave();
    }, 30_000);
    platform.onPtyExit(handlePtyExit);
    if (ownsHostFlush) platform.onRequestSessionFlush(handleSessionFlushRequest);
    window.addEventListener('pagehide', handlePageHide);

    // Inert in Tauri standalone today; see diffplug/dormouse#38 and tauri-apps/tauri#14373.
    const unsubFilesDropped = platform.onFilesDropped?.((paths) => {
      if (paths.length === 0) return;
      const sid = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      if (!sid) return;
      if (!ownsSurface(sid)) return;
      pasteFilePaths(sid, paths);
    });

    return () => {
      if (sessionSaveTimerRef.current) {
        clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
      window.removeEventListener('pagehide', handlePageHide);
      unsubFilesDropped?.();
      if (ownsHostFlush) platform.offRequestSessionFlush(handleSessionFlushRequest);
      platform.offPtyExit(handlePtyExit);
      platform.offPtyData(handlePtyData);
      unsubActivity();
      unsubPaneState();
      unsubscribeStore();
      clearInterval(interval);
      void persistSessionNow().catch(() => undefined);
    };
  }, [
    lath,
    flushSessionSave,
    ownsSurface,
    ownsHostFlush,
    persistSessionNow,
    scheduleSessionSave,
    selectedIdRef,
    selectedTypeRef,
  ]);

  return { flush: flushSessionSave };
}

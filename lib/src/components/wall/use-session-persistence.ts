import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { pasteFilePaths } from '../../lib/clipboard';
import { getPlatform } from '../../lib/platform';
import { saveSession } from '../../lib/session-save';
import { createSessionDirtyTracker } from '../../lib/session-dirty';
import {
  subscribeToActivity,
  subscribeToTerminalPaneState,
  UNNAMED_PANEL_TITLE,
} from '../../lib/terminal-registry';
import { isBrowserParams } from './browser-surface';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem, WallSelectionKind } from './wall-types';
import type { PersistedSurfaceRefs } from '../../lib/session-types';

export function useSessionPersistence({
  lath,
  doors,
  doorsRef,
  selectedIdRef,
  selectedTypeRef,
  surfaceRefsForSave,
}: {
  /** The Lath engine — the layout authority written on every commit, and the source
   *  of the visible-pane projection (`lath.listPanes()`). Stable identity, so the
   *  effect never re-subscribes. */
  lath: LathWallEngine;
  // The `doors` STATE value, not just `doorsRef`: doors can mutate with no Lath
  // store commit (e.g. `dor ensure` refreshing a minimized door's params via
  // setDoors), so the store subscription alone can't signal that the persisted
  // blob changed.
  doors: DooredItem[];
  doorsRef: RefObject<DooredItem[]>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
  surfaceRefsForSave?: () => { refs: PersistedSurfaceRefs; next: number };
}): void {
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSavePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSaveNeededRef = useRef(false);
  // See session-dirty.ts for the conservative-under-races generation model.
  const trackerRef = useRef(createSessionDirtyTracker());

  const doSave = useCallback((): Promise<void> => {
    const panes = lath.listPanes().map((p) => ({
      id: p.id,
      title: p.title ?? UNNAMED_PANEL_TITLE,
      surfaceType: isBrowserParams(p.params) ? ('browser' as const) : ('terminal' as const),
    }));
    const doors = doorsRef.current ?? [];
    const surfaceRefs = surfaceRefsForSave?.();
    // The Lath tree is the sole persisted layout; doors ride through with their tokens.
    return saveSession(getPlatform(), panes, doors, lath.serializeLayout(), surfaceRefs?.refs, surfaceRefs?.next);
  }, [lath, doorsRef, surfaceRefsForSave]);

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

  // Doors mutate without any Lath store commit (setDoors from minimize/reattach or
  // `dor ensure` param refresh), so mark dirty whenever the state array changes.
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

    const handlePtyExit = (detail: { id: string }) => {
      const ownsPane = lath.listPanes().some((p) => p.id === detail.id);
      if (!ownsPane) return;
      void flushSessionSave().catch(() => undefined);
    };
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
    // (full rationale: docs/specs/standalone.md §Persistence). Untouched flips ride
    // the pty echo of the keystroke, not the pane-state store (the registry mutates
    // silently).
    platform.onPtyData(markDirty);
    const unsubActivity = subscribeToActivity(markDirty);
    const unsubPaneState = subscribeToTerminalPaneState(markDirty);

    // Heartbeat: idle sessions no longer write (only when something marked dirty).
    const interval = setInterval(() => {
      if (isDirty()) scheduleSessionSave();
    }, 30_000);
    platform.onPtyExit(handlePtyExit);
    platform.onRequestSessionFlush(handleSessionFlushRequest);
    window.addEventListener('pagehide', handlePageHide);

    // Inert in Tauri standalone today; see diffplug/dormouse#38 and tauri-apps/tauri#14373.
    const unsubFilesDropped = platform.onFilesDropped?.((paths) => {
      if (paths.length === 0) return;
      const sid = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      if (!sid) return;
      if (!lath.listPanes().some((p) => p.id === sid)) return;
      pasteFilePaths(sid, paths);
    });

    return () => {
      if (sessionSaveTimerRef.current) {
        clearTimeout(sessionSaveTimerRef.current);
        sessionSaveTimerRef.current = null;
      }
      window.removeEventListener('pagehide', handlePageHide);
      unsubFilesDropped?.();
      platform.offRequestSessionFlush(handleSessionFlushRequest);
      platform.offPtyExit(handlePtyExit);
      platform.offPtyData(markDirty);
      unsubActivity();
      unsubPaneState();
      unsubscribeStore();
      clearInterval(interval);
      void persistSessionNow().catch(() => undefined);
    };
  }, [
    lath,
    flushSessionSave,
    persistSessionNow,
    scheduleSessionSave,
    selectedIdRef,
    selectedTypeRef,
  ]);
}

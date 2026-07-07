import { useCallback, useEffect, useRef, type RefObject } from 'react';
import { pasteFilePaths } from '../../lib/clipboard';
import { getPlatform } from '../../lib/platform';
import { saveSession } from '../../lib/session-save';
import { UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import { isBrowserParams } from './browser-surface';
import type { LathWallEngine } from './lath-wall-engine';
import type { DooredItem, WallSelectionKind } from './wall-types';

export function useSessionPersistence({
  lath,
  doorsRef,
  selectedIdRef,
  selectedTypeRef,
}: {
  /** The Lath engine — the layout authority written on every commit, and the source
   *  of the visible-pane projection (`lath.listPanes()`). Stable identity, so the
   *  effect never re-subscribes. */
  lath: LathWallEngine;
  doorsRef: RefObject<DooredItem[]>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
}): void {
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSavePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSaveNeededRef = useRef(false);

  const doSave = useCallback((): Promise<void> => {
    const panes = lath.listPanes().map((p) => ({
      id: p.id,
      title: p.title ?? UNNAMED_PANEL_TITLE,
      surfaceType: isBrowserParams(p.params) ? ('browser' as const) : ('terminal' as const),
    }));
    const doors = doorsRef.current ?? [];
    // The Lath tree is the sole persisted layout; doors ride through with their tokens.
    return saveSession(getPlatform(), panes, doors, lath.serializeLayout());
  }, [lath, doorsRef]);

  const persistSessionNow = useCallback((): Promise<void> => {
    if (sessionSavePromiseRef.current) {
      pendingSaveNeededRef.current = true;
      return sessionSavePromiseRef.current;
    }

    const runSave = (): Promise<void> => {
      pendingSaveNeededRef.current = false;
      const savePromise = doSave()
        .finally(() => {
          if (sessionSavePromiseRef.current === savePromise) {
            sessionSavePromiseRef.current = pendingSaveNeededRef.current ? runSave() : null;
          }
        });
      sessionSavePromiseRef.current = savePromise;
      return savePromise;
    };

    return runSave();
  }, [doSave]);

  const flushSessionSave = useCallback(() => {
    if (sessionSaveTimerRef.current) {
      clearTimeout(sessionSaveTimerRef.current);
      sessionSaveTimerRef.current = null;
    }
    return persistSessionNow();
  }, [persistSessionNow]);

  const scheduleSessionSave = useCallback(() => {
    if (sessionSaveTimerRef.current) return;
    sessionSaveTimerRef.current = setTimeout(() => {
      sessionSaveTimerRef.current = null;
      void persistSessionNow().catch(() => undefined);
    }, 500);
  }, [persistSessionNow]);

  useEffect(() => {
    const platform = getPlatform();
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

    // One subscription: every store commit (add/remove/resize/swap/meta) schedules a save.
    const unsubscribeStore = lath.store.subscribe(scheduleSessionSave);
    const interval = setInterval(scheduleSessionSave, 30_000);
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

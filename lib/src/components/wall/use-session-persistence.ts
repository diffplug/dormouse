import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { DockviewApi } from 'dockview-react';
import { pasteFilePaths } from '../../lib/clipboard';
import { getPlatform } from '../../lib/platform';
import { saveSession } from '../../lib/session-save';
import { UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import { isBrowserParams } from './browser-surface';
import { dockviewLayoutToLath, lathToDockviewLayout } from './lath-dockview-convert';
import type { LathWallEngine } from './lath-wall-engine';
import type { VisiblePane } from './use-dev-server-ports';
import type { DooredItem, WallSelectionKind } from './wall-types';

export function useSessionPersistence({
  dockviewApi,
  apiRef,
  lath,
  listVisiblePanes,
  doorsRef,
  selectedIdRef,
  selectedTypeRef,
}: {
  dockviewApi: DockviewApi | null;
  apiRef: RefObject<DockviewApi | null>;
  /** The Lath engine when the flag is on; null on the dockview path. */
  lath: LathWallEngine | null;
  /** Engine-neutral visible-pane projection (dockview: `api.panels`; Lath:
   *  `lath.listPanes()`). Stable identity so the effect never re-subscribes. */
  listVisiblePanes: () => VisiblePane[];
  doorsRef: RefObject<DooredItem[]>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
}): void {
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSavePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSaveNeededRef = useRef(false);

  const doSave = useCallback((): Promise<void> => {
    const panes = listVisiblePanes().map((p) => ({
      id: p.id,
      title: p.title ?? UNNAMED_PANEL_TITLE,
      surfaceType: isBrowserParams(p.params) ? ('browser' as const) : ('terminal' as const),
    }));
    const doors = doorsRef.current ?? [];

    if (lath) {
      // Dual-write: the Lath tree is authoritative; the dockview blob is derived
      // so a flag flip to OFF still restores. Doors ride through with their tokens.
      const lathLayout = lath.serializeLayout();
      return saveSession(getPlatform(), lathToDockviewLayout(lathLayout), panes, doors, lathLayout);
    }

    const api = apiRef.current;
    if (!api) return Promise.resolve();
    const json = api.toJSON();
    // Dual-write the other direction: derive the Lath layout from the live
    // dockview layout (undefined on conversion failure → omitted).
    return saveSession(getPlatform(), json, panes, doors, dockviewLayoutToLath(json) ?? undefined);
  }, [apiRef, lath, listVisiblePanes, doorsRef]);

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
    // Flag off: wait for the dockview api. Flag on: the engine is ready at mount
    // (dockview never mounts, so `dockviewApi` stays null).
    if (!dockviewApi && !lath) return;

    const platform = getPlatform();
    const handlePtyExit = (detail: { id: string }) => {
      const ownsPane = listVisiblePanes().some((p) => p.id === detail.id);
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

    // Lath: one subscription — every store commit (add/remove/resize/swap/meta)
    // schedules a save. dockview: the three layout events, as before.
    const engineDisposables = lath
      ? [{ dispose: lath.store.subscribe(scheduleSessionSave) }]
      : [
          dockviewApi!.onDidLayoutChange(scheduleSessionSave),
          dockviewApi!.onDidAddPanel(scheduleSessionSave),
          dockviewApi!.onDidRemovePanel(scheduleSessionSave),
        ];
    const interval = setInterval(scheduleSessionSave, 30_000);
    platform.onPtyExit(handlePtyExit);
    platform.onRequestSessionFlush(handleSessionFlushRequest);
    window.addEventListener('pagehide', handlePageHide);

    // Inert in Tauri standalone today; see diffplug/dormouse#38 and tauri-apps/tauri#14373.
    const unsubFilesDropped = platform.onFilesDropped?.((paths) => {
      if (paths.length === 0) return;
      const sid = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      if (!sid) return;
      if (!listVisiblePanes().some((p) => p.id === sid)) return;
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
      for (const d of engineDisposables) d.dispose();
      clearInterval(interval);
      void persistSessionNow().catch(() => undefined);
    };
  }, [
    apiRef,
    dockviewApi,
    lath,
    listVisiblePanes,
    flushSessionSave,
    persistSessionNow,
    scheduleSessionSave,
    selectedIdRef,
    selectedTypeRef,
  ]);
}

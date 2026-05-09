import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { DockviewApi } from 'dockview-react';
import { pasteFilePaths } from '../../lib/clipboard';
import { getPlatform } from '../../lib/platform';
import { saveSession } from '../../lib/session-save';
import { UNNAMED_PANEL_TITLE } from '../../lib/terminal-registry';
import type { DooredItem, WallSelectionKind } from './wall-types';

export function useSessionPersistence({
  dockviewApi,
  apiRef,
  doorsRef,
  selectedIdRef,
  selectedTypeRef,
}: {
  dockviewApi: DockviewApi | null;
  apiRef: RefObject<DockviewApi | null>;
  doorsRef: RefObject<DooredItem[]>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
}): void {
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSavePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSaveNeededRef = useRef(false);

  const doSave = useCallback((): Promise<void> => {
    const api = apiRef.current;
    if (!api) return Promise.resolve();

    const panes = api.panels.map((p) => ({ id: p.id, title: p.title ?? UNNAMED_PANEL_TITLE }));
    return saveSession(getPlatform(), api.toJSON(), panes, doorsRef.current ?? []);
  }, [apiRef, doorsRef]);

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
    if (!dockviewApi) return;

    const platform = getPlatform();
    const handlePtyExit = (detail: { id: string }) => {
      const api = apiRef.current;
      if (!api) return;
      const ownsPane = api.panels.some((p) => p.id === detail.id);
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

    const layoutDisposable = dockviewApi.onDidLayoutChange(scheduleSessionSave);
    const addDisposable = dockviewApi.onDidAddPanel(scheduleSessionSave);
    const removeDisposable = dockviewApi.onDidRemovePanel(scheduleSessionSave);
    const interval = setInterval(scheduleSessionSave, 30_000);
    platform.onPtyExit(handlePtyExit);
    platform.onRequestSessionFlush(handleSessionFlushRequest);
    window.addEventListener('pagehide', handlePageHide);

    // Inert in Tauri standalone today; see diffplug/mouseterm#38 and tauri-apps/tauri#14373.
    const unsubFilesDropped = platform.onFilesDropped?.((paths) => {
      if (paths.length === 0) return;
      const sid = selectedTypeRef.current === 'pane' ? selectedIdRef.current : null;
      if (!sid) return;
      const api = apiRef.current;
      if (!api || !api.panels.some((p) => p.id === sid)) return;
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
      layoutDisposable.dispose();
      addDisposable.dispose();
      removeDisposable.dispose();
      clearInterval(interval);
      void persistSessionNow().catch(() => undefined);
    };
  }, [
    apiRef,
    dockviewApi,
    flushSessionSave,
    persistSessionNow,
    scheduleSessionSave,
    selectedIdRef,
    selectedTypeRef,
  ]);
}

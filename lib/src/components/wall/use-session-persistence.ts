import { useCallback, useEffect, useRef, type RefObject } from 'react';
import type { DockviewApi } from 'dockview-react';
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
import type { DooredItem, WallSelectionKind } from './wall-types';

export function useSessionPersistence({
  dockviewApi,
  apiRef,
  doors,
  doorsRef,
  selectedIdRef,
  selectedTypeRef,
}: {
  dockviewApi: DockviewApi | null;
  apiRef: RefObject<DockviewApi | null>;
  // The `doors` STATE value, not just `doorsRef`: doors can mutate with no
  // dockview event (e.g. `dor ensure` refreshing a minimized door's params via
  // setDoors), so the ref alone can't signal that the persisted blob changed.
  doors: DooredItem[];
  doorsRef: RefObject<DooredItem[]>;
  selectedIdRef: RefObject<string | null>;
  selectedTypeRef: RefObject<WallSelectionKind>;
}): void {
  const sessionSaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const sessionSavePromiseRef = useRef<Promise<void> | null>(null);
  const pendingSaveNeededRef = useRef(false);
  // See session-dirty.ts for the conservative-under-races generation model.
  const trackerRef = useRef(createSessionDirtyTracker());

  const doSave = useCallback((): Promise<void> => {
    const api = apiRef.current;
    if (!api) return Promise.resolve();

    const panes = api.panels.map((p) => ({
      id: p.id,
      title: p.title ?? UNNAMED_PANEL_TITLE,
      surfaceType: isBrowserParams(p.params) ? ('browser' as const) : ('terminal' as const),
    }));
    return saveSession(getPlatform(), api.toJSON(), panes, doorsRef.current ?? []);
  }, [apiRef, doorsRef]);

  const persistSessionNow = useCallback((): Promise<void> => {
    if (sessionSavePromiseRef.current) {
      pendingSaveNeededRef.current = true;
      return sessionSavePromiseRef.current;
    }

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

    return runSave();
  }, [doSave]);

  // Doors mutate without any dockview event (setDoors from minimize/reattach or
  // `dor ensure` param refresh), so mark dirty whenever the state array changes.
  useEffect(() => {
    trackerRef.current.markDirty();
  }, [doors]);

  // Never gated on the dirty tracker — the correctness net for dirty-trigger
  // gaps (e.g. a program calling chdir() silently produces no event).
  const flushSessionSave = useCallback(() => {
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
    if (!dockviewApi) return;

    const platform = getPlatform();
    const { markDirty, isDirty } = trackerRef.current;

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

    // Content inputs mark dirty but never schedule — the heartbeat persists them
    // (full rationale: docs/specs/standalone.md §Persistence). Untouched flips
    // ride the pty echo of the keystroke, not the pane-state store (the registry
    // mutates silently). onDidActivePanelChange is here because focus flips may
    // not fire onDidLayoutChange, yet the serialized layout records the active view.
    platform.onPtyData(markDirty);
    const unsubActivity = subscribeToActivity(markDirty);
    const unsubPaneState = subscribeToTerminalPaneState(markDirty);
    const activePanelDisposable = dockviewApi.onDidActivePanelChange(markDirty);

    // Heartbeat: idle sessions no longer write.
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
      platform.offPtyData(markDirty);
      unsubActivity();
      unsubPaneState();
      activePanelDisposable.dispose();
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

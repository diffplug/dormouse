/** Pocket's shared mobile wall composition; see `docs/specs/pocket-app.md`. */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { DirectoryEntry } from 'remote-lib-common';
import {
  MobileTerminalUi,
  paneMouseOverride,
  type MobileTerminalTouchMode,
  type MobileTerminalView,
} from '../../components/MobileTerminalUi';
import { MobileSettings } from '../../components/MobileSettings';
import { MobileWall } from '../../components/MobileWall';
import { useMobileFontSize } from '../../lib/mobile-font-size';
import {
  getMouseSelectionSnapshot,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from '../../lib/mouse-selection';
import { getTerminalInstance, refitSession, writeUserInput } from '../../lib/terminal-registry';
import { doPaste } from '../../lib/clipboard';
import type { RemotePtyAdapter } from '../client/remote-adapter';
import { applyPocketTheme, restorePocketTheme, usePocketTheme } from './pocket-theme';
import {
  activatePane,
  directorySessionItems,
  directoryWallSessions,
  pickerEntries,
} from './wall-model';

export function PocketWall({ adapter, onError, persist = true }: {
  adapter: RemotePtyAdapter;
  onError?: (error: unknown) => void;
  /**
   * Whether the theme and Settings choices are restored and saved. The one-time
   * page passes false: it keeps nothing, so the theme is Pocket's default.
   */
  persist?: boolean;
}): React.ReactElement {
  // App restores the theme before this renders; repeat idempotently so isolated
  // PocketWall consumers receive the same theme contract too.
  usePocketTheme(persist ? restorePocketTheme : applyPocketTheme);
  useMobileFontSize(persist);
  const [entries, setEntries] = useState<DirectoryEntry[]>(() => adapter.getDirectoryEntries());
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [touchMode, setTouchMode] = useState<MobileTerminalTouchMode>('gestures');
  const [view, setView] = useState<MobileTerminalView>('terminal');
  // Picker order throughout — the list, the wall's swipe order, and the default
  // pane, which is therefore one the Burrow's own Window shows.
  const attachableEntries = useMemo(() => pickerEntries(entries), [entries]);

  // Track the live directory. Re-read on subscribe in case a snapshot landed
  // between the initial render and this effect.
  useEffect(() => {
    setEntries(adapter.getDirectoryEntries());
    return adapter.subscribeDirectory(setEntries);
  }, [adapter]);

  // Default to (and stay on a valid) pane as the directory changes.
  useEffect(() => {
    if (activePaneId && attachableEntries.some((entry) => entry.surfaceId === activePaneId)) return;
    setActivePaneId(attachableEntries[0]?.surfaceId ?? null);
  }, [attachableEntries, activePaneId]);

  // One attachment at a time: on every active-pane change, attach it with the
  // pane's current xterm dims (if it exists yet), then refit through the now-
  // valid attached resize path.
  useEffect(() => {
    if (!activePaneId) return;
    const term = getTerminalInstance(activePaneId);
    const dims = term ? { cols: term.cols, rows: term.rows } : null;
    let live = true;
    void activatePane(adapter, activePaneId, dims, refitSession).catch((error: unknown) => {
      if (!live) return;
      if (onError) onError(error);
      else console.warn('[pocket] could not attach terminal', error);
    });
    return () => { live = false; };
  }, [adapter, activePaneId, onError]);

  const wallSessions = useMemo(() => directoryWallSessions(attachableEntries), [attachableEntries]);
  const sessionItems = useMemo(
    () => directorySessionItems(attachableEntries, activePaneId),
    [attachableEntries, activePaneId],
  );

  const mouseStates = useSyncExternalStore(
    subscribeToMouseSelection,
    getMouseSelectionSnapshot,
    getMouseSelectionSnapshot,
  );
  const activeMouseState = activePaneId ? mouseStates.get(activePaneId) : undefined;
  const cursorTouchAvailable =
    activeMouseState?.mouseReporting !== undefined && activeMouseState.mouseReporting !== 'none';

  // Every pane, not just the active one: `paneMouseOverride` is a function of
  // touch mode and that pane's own reporting, so one switched away from would
  // otherwise keep a stale override.
  useEffect(() => {
    for (const entry of entries) {
      const reporting = mouseStates.get(entry.surfaceId)?.mouseReporting ?? 'none';
      setMouseOverride(entry.surfaceId, paneMouseOverride(touchMode, reporting));
    }
  }, [entries, mouseStates, touchMode]);

  const handleSendInput = useCallback(
    (data: string) => {
      if (activePaneId) writeUserInput(activePaneId, data);
    },
    [activePaneId],
  );

  const handlePaste = useCallback(async (text?: string) => {
    if (!activePaneId) return;
    await doPaste(activePaneId, text);
  }, [activePaneId]);

  return (
    <MobileTerminalUi
      className="h-full"
      terminal={
        <MobileWall
          sessions={wallSessions}
          sessionItems={sessionItems}
          onSessionTodoClear={null}
          activeSessionId={activePaneId ?? undefined}
          onActiveSessionChange={setActivePaneId}
          onSessionMinimize={() => setView('sessions')}
          showKillButton={false}
        />
      }
      interactive
      activeTouchMode={touchMode}
      onTouchModeChange={setTouchMode}
      activeView={view}
      onViewChange={setView}
      cursorTouchAvailable={cursorTouchAvailable}
      sessions={sessionItems}
      onSessionSelect={setActivePaneId}
      settings={<MobileSettings persist={persist} />}
      onSendInput={handleSendInput}
      onPaste={handlePaste}
    />
  );
}

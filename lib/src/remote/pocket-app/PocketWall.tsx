/**
 * The Pocket wall experience: `MobileTerminalUi` + `MobileWall` driven by a
 * connected {@link RemotePtyAdapter}. Same composition the website playground
 * proves out with `FakePtyAdapter` (`PocketTerminalExperience`), minus the
 * tutorial/shell-registry machinery — the Host owns the shells here.
 *
 * Sessions come straight from the adapter's directory snapshot (id = surfaceId).
 * v1 allows one attachment per session, so every active-pane change funnels
 * through {@link RemotePtyAdapter.setActivePane}; the registry's own resize path
 * keeps the attached pane sized. Writes and paste target the active pane.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useState,
  useSyncExternalStore,
} from 'react';
import type { DirectoryEntry } from 'server-lib-common';
import {
  MobileTerminalUi,
  type MobileTerminalKeyboardMode,
  type MobileTerminalTouchMode,
} from '../../components/MobileTerminalUi';
import { MobileWall } from '../../components/MobileWall';
import {
  getMouseSelectionSnapshot,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from '../../lib/mouse-selection';
import { getTerminalInstance, refitSession } from '../../lib/terminal-registry';
import { doPaste } from '../../lib/clipboard';
import type { RemotePtyAdapter } from '../client/remote-adapter';
import { usePocketTheme } from './pocket-theme';
import {
  activatePane,
  attachableDirectoryEntries,
  directorySessionItems,
  directoryWallSessions,
} from './wall-model';

export function PocketWall({ adapter }: { adapter: RemotePtyAdapter }): React.ReactElement {
  // App restores the theme before this renders; repeat idempotently so isolated
  // PocketWall consumers receive the same theme contract too.
  usePocketTheme();
  const [entries, setEntries] = useState<DirectoryEntry[]>(() => adapter.getDirectoryEntries());
  const [activePaneId, setActivePaneId] = useState<string | null>(null);
  const [touchMode, setTouchMode] = useState<MobileTerminalTouchMode>('gestures');
  const [keyboardMode, setKeyboardMode] = useState<MobileTerminalKeyboardMode>('type');
  const attachableEntries = useMemo(() => attachableDirectoryEntries(entries), [entries]);

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
    void activatePane(adapter, activePaneId, dims, refitSession);
  }, [adapter, activePaneId]);

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

  // Touch mode × each pane's own reporting decides its mouse override — configure
  // every pane so one switched away from isn't left in a stale override.
  useEffect(() => {
    for (const entry of entries) {
      const reporting = mouseStates.get(entry.surfaceId)?.mouseReporting ?? 'none';
      const override = touchMode === 'selection' && reporting !== 'none' ? 'permanent' : 'off';
      setMouseOverride(entry.surfaceId, override);
    }
  }, [entries, mouseStates, touchMode]);

  const handleSendInput = useCallback(
    (data: string) => {
      if (activePaneId) adapter.writePty(activePaneId, data);
    },
    [adapter, activePaneId],
  );

  const handlePaste = useCallback(async () => {
    if (!activePaneId) return;
    await doPaste(activePaneId);
  }, [activePaneId]);

  return (
    <MobileTerminalUi
      className="h-full"
      terminal={
        <MobileWall
          sessions={wallSessions}
          activeSessionId={activePaneId ?? undefined}
          onActiveSessionChange={setActivePaneId}
          onSessionMinimize={() => setKeyboardMode('sessions')}
          showKillButton={false}
        />
      }
      interactive
      activeTouchMode={touchMode}
      onTouchModeChange={setTouchMode}
      activeKeyboardMode={keyboardMode}
      onKeyboardModeChange={setKeyboardMode}
      cursorTouchAvailable={cursorTouchAvailable}
      sessions={sessionItems}
      onSessionSelect={setActivePaneId}
      onSendInput={handleSendInput}
      onPaste={handlePaste}
    />
  );
}

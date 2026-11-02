/** Pocket's shared mobile wall composition; see `docs/specs/pocket-app.md`. */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
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
import { MobileCloseDialog } from '../../components/MobileCloseDialog';
import { MobileWall } from '../../components/MobileWall';
import { useMobileFontSize } from '../../lib/mobile-font-size';
import {
  getMouseSelectionSnapshot,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from '../../lib/mouse-selection';
import { getTerminalInstance, refitSession, writeUserInput } from '../../lib/terminal-registry';
import { doPaste } from '../../lib/clipboard';
import { FrameClient, type FrameSession } from '../client/frame-client';
import type { RemotePtyAdapter } from '../client/remote-adapter';
import { getToolDirty } from '../../lib/tool-dirty-store';
import { frameOriginFor, MAX_FRAMES_PER_SESSION } from 'remote-lib-common';
import { frameSalt } from './frame-salt';
import { PK } from './pocket-chrome';
import { PocketBrowserFrame, type FrameTransport } from './PocketBrowserFrame';
import { useSurfaceClose } from './use-surface-close';
import { applyPocketTheme, restorePocketTheme, usePocketTheme } from './pocket-theme';
import {
  activatePane,
  directorySessionItems,
  directoryWallSessions,
  framedPage,
  nextKeptFrames,
  pickerEntries,
  surfaceKindOf,
} from './wall-model';

/** What a phone that frames pages needs; absent, it shows terminals alone. */
export interface PocketBrowsers {
  session: FrameSession;
  burrowId: string;
  frameDomain: string;
  transport: FrameTransport;
  onReconnect: () => void;
}

export function PocketWall({ adapter, browsers, onError, persist = true, sessionsHeader }: {
  adapter: RemotePtyAdapter;
  browsers?: PocketBrowsers;
  onError?: (error: unknown) => void;
  /** What this connection is and how to leave it, which heads the Sessions screen. */
  sessionsHeader?: React.ReactNode;
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
  // A Tool opens on its browser, so what is kept is the ones switched away from it.
  const [terminalShown, setTerminalShown] = useState<ReadonlySet<string>>(() => new Set());
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

  const activeEntry = attachableEntries.find((entry) => entry.surfaceId === activePaneId) ?? null;
  const activeKind = activeEntry ? surfaceKindOf(activeEntry) : undefined;
  const browserShown = activeKind === 'browser' || (activeKind === 'tool' && !terminalShown.has(activePaneId!));

  // One attachment at a time: on every active-pane change, attach it with the
  // pane's current xterm dims (if it exists yet), then refit through the now-
  // valid attached resize path. A browser showing needs none, so holds no pane.
  useEffect(() => {
    if (!activePaneId) return;
    let live = true;
    const fail = (error: unknown) => {
      if (!live) return;
      if (onError) onError(error);
      else console.warn('[pocket] could not attach terminal', error);
    };
    if (browserShown) {
      void adapter.clearActivePane().catch(fail);
      return () => { live = false; };
    }
    const term = getTerminalInstance(activePaneId);
    const dims = term ? { cols: term.cols, rows: term.rows } : null;
    void activatePane(adapter, activePaneId, dims, refitSession).catch(fail);
    return () => { live = false; };
  }, [adapter, activePaneId, browserShown, onError]);

  const session = browsers?.session ?? null;
  const burrowId = browsers?.burrowId;
  const frameDomain = browsers?.frameDomain;
  const saltRef = useRef<Uint8Array | null>(null);
  const originFor = useCallback((surfaceId: string, pageOrigin: string) => frameOriginFor({
    domain: frameDomain!,
    // Read here, so a page that frames nothing stores nothing.
    salt: (saltRef.current ??= frameSalt()),
    burrowId: burrowId!,
    surfaceId,
    pageOrigin,
  }), [burrowId, frameDomain]);
  // Made with its disposal, so an effect that runs twice leaves a live one.
  const [frames, setFrames] = useState<FrameClient | null>(null);
  useEffect(() => {
    if (!session) return;
    const client = new FrameClient(session);
    setFrames(client);
    return () => client.dispose();
  }, [session]);

  // The frames kept loaded, newest shown first: a page keeps its state while
  // another shows, to the session's bound, past which the oldest with no unsaved
  // edits goes.
  const [kept, setKept] = useState<readonly string[]>([]);
  useEffect(() => {
    const live = new Set(attachableEntries.filter((entry) => framedPage(entry)).map((entry) => entry.surfaceId));
    const shown = browserShown ? activePaneId : null;
    setKept((current) => nextKeptFrames(current, shown, live, MAX_FRAMES_PER_SESSION, (id) => getToolDirty(id) === true));
  }, [activePaneId, attachableEntries, browserShown]);

  const { close: closeSurface, dialog: closeDialog, closing } = useSurfaceClose(session);

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
    <div className={PK.wallHost}>
    <MobileTerminalUi
      className="h-full"
      terminal={
        <MobileWall
          sessions={wallSessions}
          sessionItems={sessionItems}
          onSessionTodoClear={null}
          activeSessionId={activePaneId ?? undefined}
          onActiveSessionChange={setActivePaneId}
          onShowSessions={() => setView('sessions')}
          showKillButton={false}
          browserShown={browserShown}
          onToolBrowserShownChange={(shown) => {
            if (!activePaneId) return;
            setTerminalShown((current) => {
              const next = new Set(current);
              if (shown) next.delete(activePaneId);
              else next.add(activePaneId);
              return next;
            });
          }}
          onBrowserClose={browsers ? closeSurface : undefined}
          // Sorted, since `kept` is newest first and moving an iframe in the DOM
          // reloads its page, unsaved edits and all.
          browser={browsers && frames ? [...kept].sort().map((id) => {
            const entry = attachableEntries.find((candidate) => candidate.surfaceId === id);
            const page = entry && framedPage(entry);
            if (!entry || !page) return null;
            return (
              <PocketBrowserFrame
                key={id}
                frames={frames}
                surfaceId={id}
                isTool={surfaceKindOf(entry) === 'tool'}
                title={entry.title}
                pageUrl={page.url}
                originFor={originFor}
                transport={browsers.transport}
                visible={id === activePaneId}
                frozen={id === closing}
                onReconnect={browsers.onReconnect}
                onShowSessions={() => setView('sessions')}
              />
            );
          }) : null}
        />
      }
      browserShown={browserShown}
      interactive
      activeTouchMode={touchMode}
      onTouchModeChange={setTouchMode}
      activeView={view}
      onViewChange={setView}
      cursorTouchAvailable={cursorTouchAvailable}
      sessions={sessionItems}
      onSessionSelect={setActivePaneId}
      sessionsHeader={sessionsHeader}
      settings={<MobileSettings persist={persist} />}
      onSendInput={handleSendInput}
      onPaste={handlePaste}
    />
    {closeDialog ? <MobileCloseDialog state={closeDialog} /> : null}
    </div>
  );
}

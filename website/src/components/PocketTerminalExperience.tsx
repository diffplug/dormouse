import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MobileTerminalUi, type MobileTerminalKeyboardMode, type MobileTerminalTouchMode } from "dormouse-lib/components/MobileTerminalUi";
import { MobileWall, useMobileWallSessionItems, type MobileWallSession } from "dormouse-lib/components/MobileWall";
import { restoreActiveTheme } from "dormouse-lib/lib/themes";
import {
  getMouseSelectionSnapshot,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from "dormouse-lib/lib/mouse-selection";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { TutorialState } from "../lib/tutorial-state";
import { BUSY_DEMO_DURATION_MS, BUSY_DEMO_INTERVAL_MS, TutRunner } from "../lib/tut-runner";
import { ChangelogRunner } from "../lib/changelog-runner";
import { POCKET_PLAYGROUND_PATH } from "../lib/playground-routing";

export const POCKET_THEME_ID = "vscode.theme-kimbie-dark.kimbie-dark";

type FakePtyAdapter = import("dormouse-lib/lib/platform/fake-adapter").FakePtyAdapter;

const POCKET_PANE = "pocket-ascii-splash";
const POCKET_SESSIONS: MobileWallSession[] = [{ id: POCKET_PANE, title: "ascii-splash" }];

function usePocketTheme() {
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restoreActiveTheme(POCKET_THEME_ID);
    restoredRef.current = true;
  }
}

export function PocketTerminalExperience({
  interactive,
  fillViewport = false,
}: {
  interactive: boolean;
  fillViewport?: boolean;
}) {
  usePocketTheme();
  const [terminalReady, setTerminalReady] = useState(false);
  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const autoStartedRef = useRef<Set<string>>(new Set());
  const spawnUnsubRef = useRef<(() => void) | null>(null);
  const busyDemoDisposeRef = useRef<(() => void) | null>(null);
  const [activePaneId, setActivePaneId] = useState(POCKET_PANE);
  const [touchMode, setTouchMode] = useState<MobileTerminalTouchMode>("gestures");
  const [keyboardMode, setKeyboardMode] = useState<MobileTerminalKeyboardMode>("type");
  const sessionItems = useMobileWallSessionItems(POCKET_SESSIONS, activePaneId);
  const mouseStates = useSyncExternalStore(
    subscribeToMouseSelection,
    getMouseSelectionSnapshot,
    getMouseSelectionSnapshot,
  );
  const activeMouseState = mouseStates.get(activePaneId);
  const cursorTouchAvailable = activeMouseState?.mouseReporting !== undefined
    && activeMouseState.mouseReporting !== "none";

  const handleOpenGithub = useCallback(() => {
    window.open(
      "https://github.com/diffplug/dormouse",
      "_blank",
      "noopener,noreferrer",
    );
  }, []);

  const handleOpenPocket = useCallback(() => {
    window.open(POCKET_PLAYGROUND_PATH, "_blank", "noopener,noreferrer");
  }, []);

  const tryAutoStart = useCallback((id: string) => {
    if (id !== POCKET_PANE) return;
    if (autoStartedRef.current.has(id)) return;
    const shellRegistry = shellRegistryRef.current;
    if (!shellRegistry) return;
    autoStartedRef.current.add(id);
    shellRegistry.ensureShell(id).runCommand("ascii-splash");
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadWall() {
      const platform = await import("dormouse-lib/lib/platform");
      const registry = await import("dormouse-lib/lib/terminal-registry");
      const scenarios = await import("dormouse-lib/lib/platform/fake-scenarios");
      const asciiSplash = await import("../lib/ascii-splash-runner");
      await import("dormouse-lib/index.css");
      if (cancelled) return;

      const adapter = platform.initPlatform("fake");
      registry.disposeAllSessions();
      adapter.reset();
      registry.initAlertStateReceiver();
      adapterRef.current = adapter;
      adapter.setDefaultScenario(scenarios.SCENARIO_SHELL_PROMPT);
      adapter.setScenario(POCKET_PANE, { name: "none", chunks: [] });

      const tutorialState = new TutorialState();
      const shellRegistry = new PlaygroundShellRegistry(
        adapter,
        (terminalId, name, args, onExit) => {
          if (name === "tut") {
            return new TutRunner({
              adapter,
              terminalId,
              state: tutorialState,
              onExit,
              onTriggerBusyDemo: () => {
                busyDemoDisposeRef.current?.();
                busyDemoDisposeRef.current = adapter.pumpActivity(
                  terminalId,
                  BUSY_DEMO_DURATION_MS,
                  BUSY_DEMO_INTERVAL_MS,
                );
              },
              onTogglePlaceToPaste: () => {},
              onOpenGithub: handleOpenGithub,
              onOpenPocket: handleOpenPocket,
            });
          }
          if (name === "ascii-splash" || name === "splash") {
            return new asciiSplash.AsciiSplashRunner({
              adapter,
              terminalId,
              args,
              onExit,
            });
          }
          if (name === "changelog") {
            return new ChangelogRunner({ adapter, terminalId, onExit });
          }
          return null;
        },
      );
      shellRegistryRef.current = shellRegistry;
      shellRegistry.ensureShell(POCKET_PANE);

      spawnUnsubRef.current = adapter.onPtySpawn(({ id }) => {
        shellRegistry.ensureShell(id);
        tryAutoStart(id);
      });
      if (adapter.hasPty(POCKET_PANE)) tryAutoStart(POCKET_PANE);

      setTerminalReady(true);
    }

    loadWall();

    return () => {
      cancelled = true;
      spawnUnsubRef.current?.();
      spawnUnsubRef.current = null;
      busyDemoDisposeRef.current?.();
      busyDemoDisposeRef.current = null;
      shellRegistryRef.current?.disposeAll();
      shellRegistryRef.current = null;
      autoStartedRef.current.clear();
      adapterRef.current = null;
    };
  }, [handleOpenGithub, handleOpenPocket, tryAutoStart]);

  useEffect(() => {
    const reporting = activeMouseState?.mouseReporting ?? "none";
    if (touchMode === "selection" && reporting !== "none") {
      setMouseOverride(activePaneId, "permanent");
    } else {
      setMouseOverride(activePaneId, "off");
    }
  }, [activeMouseState?.mouseReporting, activePaneId, touchMode]);

  return (
    <MobileTerminalUi
      terminal={
        terminalReady ? (
          <MobileWall
            sessions={POCKET_SESSIONS}
            activeSessionId={activePaneId}
            onActiveSessionChange={setActivePaneId}
            onSessionMinimize={() => setKeyboardMode("sessions")}
          />
        ) : null
      }
      interactive={interactive}
      fillViewport={fillViewport}
      activeTouchMode={touchMode}
      onTouchModeChange={setTouchMode}
      activeKeyboardMode={keyboardMode}
      onKeyboardModeChange={setKeyboardMode}
      cursorTouchAvailable={cursorTouchAvailable}
      sessions={sessionItems}
      onSessionSelect={setActivePaneId}
      onSendInput={(data) => adapterRef.current?.writePty(activePaneId, data)}
      onPaste={async () => {
        const { doPaste } = await import("dormouse-lib/lib/clipboard");
        await doPaste(activePaneId);
      }}
    />
  );
}

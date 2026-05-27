import { useCallback, useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
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
import { TutDetector } from "../lib/tut-detector";
import { TutRunner } from "../lib/tut-runner";
import { POCKET_TUTORIAL_PROFILE, type ItemId } from "../lib/tut-items";
import { ChangelogRunner } from "../lib/changelog-runner";

export const POCKET_THEME_ID = "vscode.theme-kimbie-dark.kimbie-dark";

type FakePtyAdapter = import("dormouse-lib/lib/platform/fake-adapter").FakePtyAdapter;
type MobileGestureInputId = import("dormouse-lib/lib/mobile-gesture-menu").MobileGestureInputId;

const POCKET_TUTORIAL_PANE = "pocket-tut";
const POCKET_CHANGELOG_PANE = "pocket-changelog";
const POCKET_SESSIONS: MobileWallSession[] = [
  { id: POCKET_TUTORIAL_PANE, title: "tutorial" },
  { id: POCKET_CHANGELOG_PANE, title: "changelog" },
];
const POCKET_AUTOSTART_COMMANDS = new Map<string, string>([
  [POCKET_TUTORIAL_PANE, "tut"],
  [POCKET_CHANGELOG_PANE, "changelog"],
]);

const GESTURE_ARROW_INPUTS = new Set<MobileGestureInputId>([
  "up",
  "down",
  "left",
  "right",
]);
const GITHUB_URL = "https://github.com/diffplug/dormouse";
const POCKET_NOTIFY_URL = "https://nedshed.dev/about";

const useBrowserLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

function usePocketTheme() {
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restoreActiveTheme(POCKET_THEME_ID);
    restoredRef.current = true;
  }
  // Repeat after document hydration so MobileWall initializes from real
  // Kimbie variables even if React reconciled away render-time body styles.
  useBrowserLayoutEffect(() => {
    restoreActiveTheme(POCKET_THEME_ID);
  }, []);
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
  const detectorRef = useRef<TutDetector | null>(null);
  const tutorialStateRef = useRef<TutorialState | null>(null);
  const autoStartedRef = useRef<Set<string>>(new Set());
  const spawnUnsubRef = useRef<(() => void) | null>(null);
  const sawSelectionTouchModeRef = useRef(false);
  const touchModeRef = useRef<MobileTerminalTouchMode>("gestures");
  const touchModeListenersRef = useRef(new Set<() => void>());
  const [activePaneId, setActivePaneId] = useState(POCKET_TUTORIAL_PANE);
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
    window.location.assign(GITHUB_URL);
  }, []);

  const handleNotifyPocket = useCallback(() => {
    window.location.assign(POCKET_NOTIFY_URL);
  }, []);

  const markPocketItemComplete = useCallback((id: ItemId) => {
    tutorialStateRef.current?.markComplete(id);
  }, []);

  const getPocketTouchMode = useCallback(() => touchModeRef.current, []);

  const subscribeToPocketTouchMode = useCallback((listener: () => void) => {
    touchModeListenersRef.current.add(listener);
    return () => {
      touchModeListenersRef.current.delete(listener);
    };
  }, []);

  const publishTouchMode = useCallback((nextMode: MobileTerminalTouchMode) => {
    touchModeRef.current = nextMode;
    for (const listener of touchModeListenersRef.current) listener();
  }, []);

  const handleTouchModeChange = useCallback((nextMode: MobileTerminalTouchMode) => {
    publishTouchMode(nextMode);
    setTouchMode(nextMode);
    if (nextMode === "selection") {
      sawSelectionTouchModeRef.current = true;
      return;
    }
    if (nextMode === "gestures" && sawSelectionTouchModeRef.current) {
      sawSelectionTouchModeRef.current = false;
      markPocketItemComplete("gn-touch-mode");
    }
  }, [markPocketItemComplete, publishTouchMode]);

  const handleGestureInput = useCallback((input: MobileGestureInputId) => {
    if (GESTURE_ARROW_INPUTS.has(input)) {
      markPocketItemComplete("gn-arrows");
    } else if (input === "enter") {
      markPocketItemComplete("gn-enter");
    } else if (input === "esc") {
      markPocketItemComplete("gn-esc");
    }
  }, [markPocketItemComplete]);

  const tryAutoStart = useCallback((id: string) => {
    const command = POCKET_AUTOSTART_COMMANDS.get(id);
    if (!command) return;
    if (autoStartedRef.current.has(id)) return;
    const shellRegistry = shellRegistryRef.current;
    if (!shellRegistry) return;
    autoStartedRef.current.add(id);
    shellRegistry.ensureShell(id).runCommand(command);
  }, []);

  useEffect(() => {
    let cancelled = false;

    async function loadWall() {
      const platform = await import("dormouse-lib/lib/platform");
      const registry = await import("dormouse-lib/lib/terminal-registry");
      const mouseSelection = await import("dormouse-lib/lib/mouse-selection");
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
      for (const session of POCKET_SESSIONS) {
        adapter.setScenario(session.id, { name: "none", chunks: [] });
      }

      const tutorialState = new TutorialState(POCKET_TUTORIAL_PROFILE.sections);
      tutorialStateRef.current = tutorialState;
      const detector = new TutDetector(tutorialState, registry, mouseSelection);
      detector.attach({
        activePanel: { id: POCKET_TUTORIAL_PANE },
        onDidActivePanelChange: () => ({ dispose: () => {} }),
      });
      detectorRef.current = detector;
      const shellRegistry = new PlaygroundShellRegistry(
        adapter,
        (terminalId, name, args, onExit) => {
          if (name === "tut") {
            return new TutRunner({
              adapter,
              terminalId,
              state: tutorialState,
              profile: POCKET_TUTORIAL_PROFILE,
              onExit,
              onOpenGithub: handleOpenGithub,
              onNotifyPocket: handleNotifyPocket,
              getPocketTouchMode,
              subscribeToPocketTouchMode,
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
      for (const session of POCKET_SESSIONS) shellRegistry.ensureShell(session.id);

      spawnUnsubRef.current = adapter.onPtySpawn(({ id }) => {
        shellRegistry.ensureShell(id);
        tryAutoStart(id);
      });
      for (const session of POCKET_SESSIONS) {
        if (adapter.hasPty(session.id)) tryAutoStart(session.id);
      }

      setTerminalReady(true);
    }

    loadWall();

    return () => {
      cancelled = true;
      spawnUnsubRef.current?.();
      spawnUnsubRef.current = null;
      detectorRef.current?.dispose();
      detectorRef.current = null;
      shellRegistryRef.current?.disposeAll();
      shellRegistryRef.current = null;
      tutorialStateRef.current = null;
      autoStartedRef.current.clear();
      sawSelectionTouchModeRef.current = false;
      touchModeListenersRef.current.clear();
      adapterRef.current = null;
    };
  }, [getPocketTouchMode, handleNotifyPocket, handleOpenGithub, subscribeToPocketTouchMode, tryAutoStart]);

  // Touch mode is a single global UI state, so each pane's mouse override is a
  // pure function of (touch mode) × (that pane's own reporting) — not of which
  // pane happens to be active. Configuring every pane prevents a pane the user
  // switched away from being left stuck in a stale override (e.g. a
  // mouse-reporting pane left "permanent" after leaving Select mode).
  useEffect(() => {
    for (const session of POCKET_SESSIONS) {
      const reporting = mouseStates.get(session.id)?.mouseReporting ?? "none";
      const override = touchMode === "selection" && reporting !== "none" ? "permanent" : "off";
      setMouseOverride(session.id, override);
    }
  }, [mouseStates, touchMode]);

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
      onTouchModeChange={handleTouchModeChange}
      activeKeyboardMode={keyboardMode}
      onKeyboardModeChange={setKeyboardMode}
      cursorTouchAvailable={cursorTouchAvailable}
      sessions={sessionItems}
      onSessionSelect={setActivePaneId}
      onSendInput={(data) => adapterRef.current?.writePty(activePaneId, data)}
      onGestureInput={handleGestureInput}
      onPaste={async () => {
        const { doPaste } = await import("dormouse-lib/lib/clipboard");
        await doPaste(activePaneId);
      }}
    />
  );
}

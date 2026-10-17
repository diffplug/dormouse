import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { MobileTerminalUi, paneMouseOverride, type MobileTerminalKeyboardMode, type MobileTerminalTouchMode } from "dormouse-lib/components/MobileTerminalUi";
import { MobileWall, useMobileWallSessionItems, type MobileWallSession } from "dormouse-lib/components/MobileWall";
import { writeUserInput } from "dormouse-lib/lib/terminal-registry";
import {
  getMouseSelectionSnapshot,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from "dormouse-lib/lib/mouse-selection";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { TutorialState } from "../lib/tutorial-state";
import { TutDetector } from "../lib/tut-detector";
import { TutRunner } from "../lib/tut-runner";
import { POCKET_TUTORIAL_PROFILE } from "../lib/tut-items";
import { ChangelogRunner } from "../lib/changelog-runner";
import { startAlertProgram } from "../lib/alert-programs";
import { useRestoredTheme } from "dormouse-lib/lib/themes";

import { WEBSITE_DEFAULT_THEME_ID } from "../lib/website-theme";

type FakePtyAdapter = import("dormouse-lib/lib/platform/fake-adapter").FakePtyAdapter;
type MobileGestureInputId = import("dormouse-lib/lib/mobile-gesture-menu").MobileGestureInputId;

const POCKET_TUTORIAL_PANE = "pocket-tut";
const POCKET_CHANGELOG_PANE = "pocket-changelog";
const POCKET_SESSIONS: MobileWallSession[] = [
  { id: POCKET_TUTORIAL_PANE, title: "tutorial" },
  { id: POCKET_CHANGELOG_PANE, title: "changelog" },
];
const POCKET_AUTOSTART_COMMANDS = new Map<string, string>([
  [POCKET_TUTORIAL_PANE, "tutorial"],
  [POCKET_CHANGELOG_PANE, "changelog"],
]);

const GITHUB_URL = "https://github.com/diffplug/dormouse";
const POCKET_NOTIFY_URL = "/hosted/#remote-control";

export function PocketTerminalExperience({
  interactive,
  fillViewport = false,
}: {
  interactive: boolean;
  fillViewport?: boolean;
}) {
  useRestoredTheme(WEBSITE_DEFAULT_THEME_ID);
  const [terminalReady, setTerminalReady] = useState(false);
  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const detectorRef = useRef<TutDetector | null>(null);
  const autoStartedRef = useRef<Set<string>>(new Set());
  const spawnUnsubRef = useRef<(() => void) | null>(null);
  const tutorialRunnerRef = useRef<TutRunner | null>(null);
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

  const getPocketTouchMode = useCallback(() => touchModeRef.current, []);

  const subscribeToPocketTouchMode = useCallback((listener: () => void) => {
    touchModeListenersRef.current.add(listener);
    return () => {
      touchModeListenersRef.current.delete(listener);
    };
  }, []);

  const handleTouchModeChange = useCallback((nextMode: MobileTerminalTouchMode) => {
    touchModeRef.current = nextMode;
    for (const listener of touchModeListenersRef.current) listener();
    setTouchMode(nextMode);
  }, []);

  const handleGestureInput = useCallback((input: MobileGestureInputId) => {
    if (activePaneId === POCKET_TUTORIAL_PANE) tutorialRunnerRef.current?.handleGestureInput(input);
  }, [activePaneId]);

  const handleGestureScroll = useCallback((lines: number) => {
    if (activePaneId === POCKET_TUTORIAL_PANE) tutorialRunnerRef.current?.handleGestureScroll(lines);
  }, [activePaneId]);

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
      const themes = await import("dormouse-lib/lib/themes");
      const terminalTheme = await import("dormouse-lib/lib/terminal-theme");
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
      const detector = new TutDetector({
        state: tutorialState,
        activityStore: registry,
        mouseStore: mouseSelection,
        themeStore: themes,
      });
      detector.start();
      detectorRef.current = detector;
      const shellRegistry = new PlaygroundShellRegistry(
        adapter,
        (terminalId, name, args, onExit) => {
          if (name === "tutorial") {
            const runner = new TutRunner({
              adapter,
              terminalId,
              state: tutorialState,
              profile: POCKET_TUTORIAL_PROFILE,
              onExit,
              onOpenGithub: handleOpenGithub,
              onNotifyPocket: handleNotifyPocket,
              getPocketTouchMode,
              subscribeToPocketTouchMode,
              getTerminalTheme: terminalTheme.getTerminalTheme,
              subscribeToTerminalTheme: terminalTheme.onTerminalThemeChange,
            });
            if (terminalId === POCKET_TUTORIAL_PANE) tutorialRunnerRef.current = runner;
            return runner;
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
          return startAlertProgram(name, args, (data) => adapter.sendOutput(terminalId, data), onExit);
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
      autoStartedRef.current.clear();
      tutorialRunnerRef.current = null;
      touchModeListenersRef.current.clear();
      adapterRef.current = null;
    };
  }, [getPocketTouchMode, handleNotifyPocket, handleOpenGithub, subscribeToPocketTouchMode, tryAutoStart]);

  // Every pane, not just the active one: `paneMouseOverride` is a function of
  // touch mode and that pane's own reporting, so a pane the user switched away
  // from would otherwise be left stuck in a stale override.
  useEffect(() => {
    for (const session of POCKET_SESSIONS) {
      const reporting = mouseStates.get(session.id)?.mouseReporting ?? "none";
      setMouseOverride(session.id, paneMouseOverride(touchMode, reporting));
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
      onSendInput={(data) => { if (adapterRef.current) writeUserInput(activePaneId, data); }}
      onGestureInput={handleGestureInput}
      onGestureScroll={handleGestureScroll}
      onPaste={async () => {
        const { doPaste } = await import("dormouse-lib/lib/clipboard");
        await doPaste(activePaneId);
      }}
    />
  );
}

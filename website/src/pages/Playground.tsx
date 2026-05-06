import { useState, useEffect, useCallback, useRef } from "react";
import SiteHeader from "../components/SiteHeader";
import { PlaceToPaste } from "../components/PlaceToPaste";
import { ThemePicker } from "mouseterm-lib/components/ThemePicker";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { TutorialState } from "../lib/tutorial-state";
import { TutDetector } from "../lib/tut-detector";
import { BUSY_DEMO_DURATION_MS, BUSY_DEMO_INTERVAL_MS, TutRunner } from "../lib/tut-runner";

export { Playground as Component };

const PANE_MAIN = "tut-main";
const PANE_BOXED = "tut-boxed";
const PANE_SPLASH = "tut-splash";

type FakePtyAdapter = import("mouseterm-lib/lib/platform/fake-adapter").FakePtyAdapter;
type WallEvent = import("mouseterm-lib/components/Wall").WallEvent;
type DockviewDisposable = { dispose: () => void };

function Playground() {
  const [WallModule, setWallModule] = useState<{
    Wall: React.ComponentType<any>;
  } | null>(null);
  const [placeToPasteOpen, setPlaceToPasteOpen] = useState(false);
  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const detectorRef = useRef<TutDetector | null>(null);
  const stateRef = useRef<TutorialState | null>(null);
  const dockviewDisposablesRef = useRef<DockviewDisposable[]>([]);
  const tutorialAutoStartedRef = useRef(false);
  const splashAutoStartedRef = useRef(false);
  const spawnUnsubRef = useRef<(() => void) | null>(null);
  const busyDemoDisposeRef = useRef<(() => void) | null>(null);
  const alertDemoPaneIdRef = useRef<string | null>(null);

  const tryAutoStartTutorial = useCallback(() => {
    if (tutorialAutoStartedRef.current) return;
    const shellRegistry = shellRegistryRef.current;
    if (!shellRegistry) return;
    tutorialAutoStartedRef.current = true;
    shellRegistry.ensureShell(PANE_MAIN).runCommand("tut");
  }, []);

  const tryAutoStartSplash = useCallback(() => {
    if (splashAutoStartedRef.current) return;
    const shellRegistry = shellRegistryRef.current;
    if (!shellRegistry) return;
    splashAutoStartedRef.current = true;
    shellRegistry.ensureShell(PANE_SPLASH).runCommand("ascii-splash");
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadWall() {
      const platform = await import("mouseterm-lib/lib/platform");
      const registry = await import("mouseterm-lib/lib/terminal-registry");
      const mouseSelection = await import("mouseterm-lib/lib/mouse-selection");
      const wall = await import("mouseterm-lib/components/Wall");
      const scenarios = await import("mouseterm-lib/lib/platform/fake-scenarios");
      const asciiSplash = await import("../lib/ascii-splash-runner");
      await import("mouseterm-lib/index.css");
      if (cancelled) return;

      const adapter = platform.initPlatform("fake");
      registry.initAlertStateReceiver();
      adapterRef.current = adapter;

      adapter.setDefaultScenario(scenarios.SCENARIO_SHELL_PROMPT);
      adapter.setScenario(PANE_BOXED, scenarios.SCENARIO_BOXED_PARAGRAPH);
      // tut-main is owned by the TutRunner, tut-splash by AsciiSplashRunner —
      // explicitly suppress the default shell-prompt scenario, otherwise
      // spawnPty queues a delayed `user@mouseterm:~$` write that lands
      // underneath the runner output and stays there until the next
      // re-render clears it.
      adapter.setScenario(PANE_MAIN, { name: "none", chunks: [] });
      adapter.setScenario(PANE_SPLASH, { name: "none", chunks: [] });

      const tutorialState = new TutorialState();
      stateRef.current = tutorialState;
      const detector = new TutDetector(tutorialState, registry, mouseSelection, {
        onAlertDemoPaneChange: (id) => {
          alertDemoPaneIdRef.current = id;
        },
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
              onExit,
              onTriggerBusyDemo: () => {
                const paneId = alertDemoPaneIdRef.current ?? PANE_BOXED;
                const sessionId = registry.resolveTerminalSessionId(paneId);
                busyDemoDisposeRef.current?.();
                busyDemoDisposeRef.current = adapter.pumpActivity(
                  sessionId,
                  BUSY_DEMO_DURATION_MS,
                  BUSY_DEMO_INTERVAL_MS,
                );
              },
              onTogglePlaceToPaste: () => setPlaceToPasteOpen((open) => !open),
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
          return null;
        },
      );
      shellRegistryRef.current = shellRegistry;

      shellRegistry.ensureShell(PANE_MAIN);
      shellRegistry.ensureShell(PANE_BOXED);
      shellRegistry.ensureShell(PANE_SPLASH);

      // Subscribe before Wall mounts so the spawn fired by TerminalPane's
      // mount effect doesn't race past us. If the pty already exists by
      // the time we get here, fire immediately.
      spawnUnsubRef.current = adapter.onPtySpawn(({ id }) => {
        if (id === PANE_MAIN) tryAutoStartTutorial();
        if (id === PANE_SPLASH) tryAutoStartSplash();
      });
      if (adapter.hasPty(PANE_MAIN)) tryAutoStartTutorial();
      if (adapter.hasPty(PANE_SPLASH)) tryAutoStartSplash();

      setWallModule({ Wall: wall.Wall });
    }
    loadWall();

    return () => {
      cancelled = true;
      for (const disposable of dockviewDisposablesRef.current) {
        disposable.dispose();
      }
      dockviewDisposablesRef.current = [];
      detectorRef.current?.dispose();
      detectorRef.current = null;
      shellRegistryRef.current?.disposeAll();
      shellRegistryRef.current = null;
      stateRef.current = null;
      tutorialAutoStartedRef.current = false;
      splashAutoStartedRef.current = false;
      alertDemoPaneIdRef.current = null;
      spawnUnsubRef.current?.();
      spawnUnsubRef.current = null;
      busyDemoDisposeRef.current?.();
      busyDemoDisposeRef.current = null;
    };
  }, []);

  const handleApiReady = useCallback((api: any) => {
    const shellRegistry = shellRegistryRef.current;
    shellRegistry?.ensureShell(PANE_MAIN);

    const addDisposable = api.onDidAddPanel((panel: { id?: string } | undefined) => {
      if (panel?.id) shellRegistryRef.current?.ensureShell(panel.id);
    });
    dockviewDisposablesRef.current.push(addDisposable);

    api.addPanel({
      id: PANE_BOXED,
      component: "terminal",
      tabComponent: "terminal",
      title: "changelog",
      position: { referencePanel: PANE_MAIN, direction: "right" },
    });
    api.addPanel({
      id: PANE_SPLASH,
      component: "terminal",
      tabComponent: "terminal",
      title: "ascii-splash",
      position: { referencePanel: PANE_BOXED, direction: "below" },
    });

    const mainPanel = api.getPanel(PANE_MAIN);
    if (mainPanel) {
      mainPanel.api.setTitle("tutorial");
      mainPanel.api.setActive();
    }

    detectorRef.current?.attach(api);
  }, []);

  const handleWallEvent = useCallback((event: WallEvent) => {
    detectorRef.current?.handleWallEvent(event);
  }, []);

  return (
    <>
      <SiteHeader
        activePath="/playground"
        themeAware
        controls={
          <ThemePicker
            variant="playground-header"
            defaultThemeId="vscode.theme-kimbie-dark.kimbie-dark"
          />
        }
      />

      <main className="fixed top-16 right-0 bottom-0 left-0 flex min-h-0 md:top-20">
        {WallModule ? (
          <WallModule.Wall
            initialPaneIds={[PANE_MAIN]}
            initialMode="passthrough"
            onApiReady={handleApiReady}
            onEvent={handleWallEvent}
          />
        ) : null}
      </main>
      {placeToPasteOpen ? (
        <PlaceToPaste onClose={() => setPlaceToPasteOpen(false)} />
      ) : null}
    </>
  );
}

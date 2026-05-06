import { useState, useEffect, useCallback, useRef } from "react";
import SiteHeader from "../components/SiteHeader";
import { ThemePicker } from "mouseterm-lib/components/ThemePicker";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { TutorialState } from "../lib/tutorial-state";
import { TutDetector } from "../lib/tut-detector";
import { BUSY_DEMO_DURATION_MS, TutRunner } from "../lib/tut-runner";

export { Playground as Component };

const PANE_MAIN = "tut-main";
const PANE_TARGET = "tut-target";
const PANE_BOXED = "tut-boxed";

type FakePtyAdapter = import("mouseterm-lib/lib/platform/fake-adapter").FakePtyAdapter;
type WallEvent = import("mouseterm-lib/components/Wall").WallEvent;
type DockviewDisposable = { dispose: () => void };

function Playground() {
  const [WallModule, setWallModule] = useState<{
    Wall: React.ComponentType<any>;
  } | null>(null);
  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const detectorRef = useRef<TutDetector | null>(null);
  const stateRef = useRef<TutorialState | null>(null);
  const dockviewDisposablesRef = useRef<DockviewDisposable[]>([]);
  const tutorialAutoStartedRef = useRef(false);
  const tutorialAutoStartRafRef = useRef<number | null>(null);

  const scheduleTutorialAutoStart = useCallback(() => {
    if (tutorialAutoStartedRef.current || tutorialAutoStartRafRef.current !== null) return;

    let attempts = 0;
    const tick = () => {
      tutorialAutoStartRafRef.current = null;
      if (tutorialAutoStartedRef.current) return;

      const adapter = adapterRef.current;
      const shellRegistry = shellRegistryRef.current;
      if (!adapter || !shellRegistry) return;

      if (adapter.hasPty(PANE_MAIN)) {
        tutorialAutoStartedRef.current = true;
        shellRegistry.ensureShell(PANE_MAIN).runCommand("tut");
        return;
      }

      attempts += 1;
      if (attempts < 60) {
        tutorialAutoStartRafRef.current = requestAnimationFrame(tick);
      }
    };

    tutorialAutoStartRafRef.current = requestAnimationFrame(tick);
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
      adapter.setScenario(PANE_TARGET, scenarios.SCENARIO_SHELL_PROMPT);
      adapter.setScenario(PANE_BOXED, scenarios.SCENARIO_BOXED_PARAGRAPH);
      // tut-main is owned by the TutRunner — explicitly suppress the
      // default shell-prompt scenario, otherwise spawnPty queues a
      // delayed `user@mouseterm:~$` write that lands underneath the
      // menu and stays there until the next runner re-render clears it.
      adapter.setScenario(PANE_MAIN, { name: "none", chunks: [] });

      const tutorialState = new TutorialState();
      stateRef.current = tutorialState;
      const detector = new TutDetector(tutorialState, registry, mouseSelection);
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
                adapter.pumpActivity(PANE_TARGET, BUSY_DEMO_DURATION_MS, 800);
              },
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
      shellRegistry.ensureShell(PANE_TARGET);
      shellRegistry.ensureShell(PANE_BOXED);

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
      if (tutorialAutoStartRafRef.current !== null) {
        cancelAnimationFrame(tutorialAutoStartRafRef.current);
        tutorialAutoStartRafRef.current = null;
      }
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
      id: PANE_TARGET,
      component: "terminal",
      tabComponent: "terminal",
      title: "demo",
      position: { referencePanel: PANE_MAIN, direction: "right" },
    });
    api.addPanel({
      id: PANE_BOXED,
      component: "terminal",
      tabComponent: "terminal",
      title: "release notes",
      position: { referencePanel: PANE_TARGET, direction: "below" },
    });

    const mainPanel = api.getPanel(PANE_MAIN);
    if (mainPanel) mainPanel.api.setActive();

    detectorRef.current?.attach(api);
    scheduleTutorialAutoStart();
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
            onApiReady={handleApiReady}
            onEvent={handleWallEvent}
          />
        ) : null}
      </main>
    </>
  );
}

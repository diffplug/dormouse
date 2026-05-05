import { useState, useEffect, useCallback, useRef } from "react";
import SiteHeader from "../components/SiteHeader";
import { ThemePicker } from "mouseterm-lib/components/ThemePicker";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { TutorialDetector } from "../lib/tutorial-detection";

export { Playground as Component };

// Pane IDs — stable so we can assign scenarios before mount
const PANE_MAIN = "tut-main";
const PANE_NPM = "tut-npm";
const PANE_LS = "tut-ls";

type FakePtyAdapter = import("mouseterm-lib/lib/platform/fake-adapter").FakePtyAdapter;
type WallEvent = import("mouseterm-lib/components/Wall").WallEvent;
type DockviewDisposable = { dispose: () => void };

function Playground() {
  const [WallModule, setWallModule] = useState<{
    Wall: React.ComponentType<any>;
  } | null>(null);
  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const detectorRef = useRef<TutorialDetector | null>(null);
  const dockviewDisposablesRef = useRef<DockviewDisposable[]>([]);

  useEffect(() => {
    async function loadWall() {
      const platform = await import("mouseterm-lib/lib/platform");
      const registry = await import("mouseterm-lib/lib/terminal-registry");
      const wall = await import("mouseterm-lib/components/Wall");
      const scenarios = await import("mouseterm-lib/lib/platform/fake-scenarios");
      const asciiSplash = await import("../lib/ascii-splash-runner");

      await import("mouseterm-lib/index.css");

      const adapter = platform.initPlatform("fake");
      registry.initAlertStateReceiver();
      adapterRef.current = adapter;

      adapter.setDefaultScenario(scenarios.SCENARIO_SHELL_PROMPT);
      adapter.setScenario(PANE_NPM, scenarios.SCENARIO_LONG_RUNNING);
      adapter.setScenario(PANE_LS, scenarios.SCENARIO_LS_OUTPUT);
      adapter.setScenario(PANE_MAIN, scenarios.SCENARIO_TUTORIAL_MOTD);

      // Named scenarios print demo output first; the shell takes over once
      // scenario playback ends.
      const shellRegistry = new PlaygroundShellRegistry(
        adapter,
        (terminalId, args, onExit) => new asciiSplash.AsciiSplashRunner({
          adapter,
          terminalId,
          args,
          onExit,
        }),
      );
      shellRegistryRef.current = shellRegistry;
      const mainShell = shellRegistry.ensureShell(PANE_MAIN);
      shellRegistry.ensureShell(PANE_NPM);
      shellRegistry.ensureShell(PANE_LS);

      const detector = new TutorialDetector(mainShell);
      detectorRef.current = detector;

      setWallModule({ Wall: wall.Wall });
    }
    loadWall();

    return () => {
      for (const disposable of dockviewDisposablesRef.current) {
        disposable.dispose();
      }
      dockviewDisposablesRef.current = [];
      detectorRef.current?.dispose();
      shellRegistryRef.current?.disposeAll();
      shellRegistryRef.current = null;
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
      id: PANE_NPM,
      component: "terminal",
      tabComponent: "terminal",
      title: "npm install",
      position: { referencePanel: PANE_MAIN, direction: "right" },
    });
    api.addPanel({
      id: PANE_LS,
      component: "terminal",
      tabComponent: "terminal",
      title: "project",
      position: { referencePanel: PANE_NPM, direction: "below" },
    });

    const mainPanel = api.getPanel(PANE_MAIN);
    if (mainPanel) mainPanel.api.setActive();

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
            onApiReady={handleApiReady}
            onEvent={handleWallEvent}
          />
        ) : null}
      </main>
    </>
  );
}

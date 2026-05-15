import { useState, useEffect, useCallback, useRef } from "react";
import SiteHeader from "../components/SiteHeader";
import { PlaceToPaste } from "../components/PlaceToPaste";
import { ThemePicker } from "mouseterm-lib/components/ThemePicker";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { TutorialState } from "../lib/tutorial-state";
import { TutDetector } from "../lib/tut-detector";
import { BUSY_DEMO_DURATION_MS, BUSY_DEMO_INTERVAL_MS, TutRunner } from "../lib/tut-runner";
import { ChangelogRunner } from "../lib/changelog-runner";

export { Playground as Component };

const PANE_MAIN = "tut-main";
const PANE_BOXED = "tut-boxed";
const PANE_SPLASH = "tut-splash";

type FakePtyAdapter = import("mouseterm-lib/lib/platform/fake-adapter").FakePtyAdapter;
type WallEvent = import("mouseterm-lib/components/Wall").WallEvent;
type DockviewDisposable = { dispose: () => void };

// Tailwind's md breakpoint — matches the header's `md:top-20` so the pane
// area below begins at the same threshold. Locked at mount, not reactive
// to resize.
const isPhoneAtMount = () =>
  typeof window !== "undefined" && window.innerWidth < 768;

interface PaneSpec {
  id: string;
  command: string;
}

function Playground() {
  const [WallModule, setWallModule] = useState<{
    Wall: React.ComponentType<any>;
  } | null>(null);
  const [placeToPasteOpen, setPlaceToPasteOpen] = useState(false);
  // Phone: tutorial on top, ascii-splash below. Desktop: tutorial left,
  // changelog top-right, ascii-splash bottom-right.
  const [isPhone] = useState(isPhoneAtMount);

  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const detectorRef = useRef<TutDetector | null>(null);
  const stateRef = useRef<TutorialState | null>(null);
  const dockviewDisposablesRef = useRef<DockviewDisposable[]>([]);
  const autoStartedRef = useRef<Set<string>>(new Set());
  const spawnUnsubRef = useRef<(() => void) | null>(null);
  const busyDemoDisposeRef = useRef<(() => void) | null>(null);
  const alertDemoPaneIdRef = useRef<string | null>(null);

  const tryAutoStart = useCallback((pane: PaneSpec) => {
    if (autoStartedRef.current.has(pane.id)) return;
    const shellRegistry = shellRegistryRef.current;
    if (!shellRegistry) return;
    autoStartedRef.current.add(pane.id);
    shellRegistry.ensureShell(pane.id).runCommand(pane.command);
  }, []);

  useEffect(() => {
    let cancelled = false;
    const panes: PaneSpec[] = isPhone
      ? [
          { id: PANE_MAIN, command: "tut" },
          { id: PANE_SPLASH, command: "ascii-splash" },
        ]
      : [
          { id: PANE_MAIN, command: "tut" },
          { id: PANE_BOXED, command: "changelog" },
          { id: PANE_SPLASH, command: "ascii-splash" },
        ];
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
      // Each runner-owned pane suppresses the default shell-prompt scenario,
      // otherwise spawnPty queues a delayed `user@dormouse:~$` write that
      // would land in the runner's alt-screen and corrupt its output.
      for (const pane of panes) {
        adapter.setScenario(pane.id, { name: "none", chunks: [] });
      }

      const tutorialState = new TutorialState();
      stateRef.current = tutorialState;
      const detector = new TutDetector(tutorialState, registry, mouseSelection, {
        onWatchingDemoPaneChange: (id) => {
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
          if (name === "changelog") {
            return new ChangelogRunner({ adapter, terminalId, onExit });
          }
          return null;
        },
      );
      shellRegistryRef.current = shellRegistry;

      for (const pane of panes) shellRegistry.ensureShell(pane.id);

      const paneById = new Map(panes.map((p) => [p.id, p]));
      // Subscribe before Wall mounts so the spawn fired by TerminalPane's
      // mount effect doesn't race past us. If the pty already exists by
      // the time we get here, fire immediately.
      spawnUnsubRef.current = adapter.onPtySpawn(({ id }) => {
        const pane = paneById.get(id);
        if (pane) tryAutoStart(pane);
      });
      for (const pane of panes) {
        if (adapter.hasPty(pane.id)) tryAutoStart(pane);
      }

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
      autoStartedRef.current.clear();
      alertDemoPaneIdRef.current = null;
      spawnUnsubRef.current?.();
      spawnUnsubRef.current = null;
      busyDemoDisposeRef.current?.();
      busyDemoDisposeRef.current = null;
    };
  }, [isPhone, tryAutoStart]);

  const handleApiReady = useCallback((api: any) => {
    const shellRegistry = shellRegistryRef.current;
    shellRegistry?.ensureShell(PANE_MAIN);

    const addDisposable = api.onDidAddPanel((panel: { id?: string } | undefined) => {
      if (panel?.id) shellRegistryRef.current?.ensureShell(panel.id);
    });
    dockviewDisposablesRef.current.push(addDisposable);

    if (isPhone) {
      api.addPanel({
        id: PANE_SPLASH,
        component: "terminal",
        tabComponent: "terminal",
        title: "ascii-splash",
        position: { referencePanel: PANE_MAIN, direction: "below" },
      });
    } else {
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
    }

    const mainPanel = api.getPanel(PANE_MAIN);
    if (mainPanel) {
      mainPanel.api.setTitle("tutorial");
      mainPanel.api.setActive();
    }

    detectorRef.current?.attach(api);
  }, [isPhone]);

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

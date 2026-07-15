import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import { PlaceToPaste } from "../components/PlaceToPaste";
import { POCKET_THEME_ID } from "../components/PocketTerminalExperience";
import { ThemePicker } from "dormouse-lib/components/ThemePicker";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { TutorialState } from "../lib/tutorial-state";
import { TutDetector } from "../lib/tut-detector";
import { BUSY_DEMO_DURATION_MS, BUSY_DEMO_INTERVAL_MS, TutRunner } from "../lib/tut-runner";
import { ChangelogRunner } from "../lib/changelog-runner";
import { POCKET_PLAYGROUND_PATH, usePreferredPlayground } from "../lib/playground-routing";
import {
  DESKTOP_PANES,
  DESKTOP_PLAYGROUND_LAYOUT,
  PANE_BOXED,
  PANE_MAIN,
  type DesktopPaneSpec,
} from "../lib/playground-desktop-layout";

type FakePtyAdapter = import("dormouse-lib/lib/platform/fake-adapter").FakePtyAdapter;
type WallEvent = import("dormouse-lib/components/Wall").WallEvent;

function DesktopPlaygroundUnavailable() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader activePath="/playground" style={STATIC_PAGE_HEADER_STYLE} />
      <main className="mx-auto flex min-h-screen max-w-2xl flex-col justify-center px-4 pb-10 pt-24 md:px-8 md:pt-28">
        <h1 className="mb-4 font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] text-[var(--color-text)]">
          Desktop playground
        </h1>
        <p className="text-lg leading-relaxed opacity-80 mb-4">
          This screen is too small to run the desktop playground, but it is perfect for trying the{" "}
          <Link
            to={POCKET_PLAYGROUND_PATH}
            className="text-[var(--color-caramel)] underline-offset-2 hover:underline"
          >
            Pocket playground
          </Link>
          .
        </p>
        <p className="text-lg leading-relaxed opacity-80">
          Alternatively, widen the window to fit the desktop playground and it will pop into view.
        </p>
      </main>
    </div>
  );
}

function PlaygroundDesktopExperience() {
  const [WallModule, setWallModule] = useState<{
    Wall: React.ComponentType<any>;
  } | null>(null);
  const [placeToPasteOpen, setPlaceToPasteOpen] = useState(false);

  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const detectorRef = useRef<TutDetector | null>(null);
  const stateRef = useRef<TutorialState | null>(null);
  const autoStartedRef = useRef<Set<string>>(new Set());
  const spawnUnsubRef = useRef<(() => void) | null>(null);
  const busyDemoDisposeRef = useRef<(() => void) | null>(null);
  const alertDemoPaneIdRef = useRef<string | null>(null);

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

  const tryAutoStart = useCallback((pane: DesktopPaneSpec) => {
    if (autoStartedRef.current.has(pane.id)) return;
    const shellRegistry = shellRegistryRef.current;
    if (!shellRegistry) return;
    autoStartedRef.current.add(pane.id);
    shellRegistry.ensureShell(pane.id).runCommand(pane.command);
  }, []);

  useEffect(() => {
    let cancelled = false;
    async function loadWall() {
      const platform = await import("dormouse-lib/lib/platform");
      const registry = await import("dormouse-lib/lib/terminal-registry");
      const mouseSelection = await import("dormouse-lib/lib/mouse-selection");
      const wall = await import("dormouse-lib/components/Wall");
      const scenarios = await import("dormouse-lib/lib/platform/fake-scenarios");
      const asciiSplash = await import("../lib/ascii-splash-runner");
      await import("dormouse-lib/index.css");
      if (cancelled) return;

      const adapter = platform.initPlatform("fake");
      registry.initAlertStateReceiver();
      adapterRef.current = adapter;

      adapter.setDefaultScenario(scenarios.SCENARIO_SHELL_PROMPT);
      // Each runner-owned pane suppresses the default shell-prompt scenario,
      // otherwise spawnPty queues a delayed `user@dormouse:~$` write that
      // would land in the runner's alt-screen and corrupt its output.
      for (const pane of DESKTOP_PANES) {
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
      // The detector now reads app state entirely through the WallEvent stream and
      // the activity/mouse stores — no tiling api. `start()` seeds its prev-state
      // maps and subscribes to those stores.
      detector.start();

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

      // Seed each pane's header title as a pending shell opt — the lib applies it
      // (as a user-pin, which deriveHeader ranks above the engine fallback) when
      // the terminal first spawns, after its state reset, so nothing clobbers it.
      const paneById = new Map(DESKTOP_PANES.map((p) => [p.id, p]));
      for (const pane of DESKTOP_PANES) {
        registry.setPendingShellOpts(pane.id, { title: pane.title });
      }
      // Subscribe before Wall mounts so the spawn fired by TerminalPane's
      // mount effect doesn't race past us. If the pty already exists by
      // the time we get here, fire immediately.
      spawnUnsubRef.current = adapter.onPtySpawn(({ id }) => {
        const pane = paneById.get(id);
        if (pane) tryAutoStart(pane);
      });
      for (const pane of DESKTOP_PANES) {
        if (adapter.hasPty(pane.id)) tryAutoStart(pane);
      }

      setWallModule({ Wall: wall.Wall });
    }
    loadWall();

    return () => {
      cancelled = true;
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
  }, [handleOpenGithub, handleOpenPocket, tryAutoStart]);

  const handleWallEvent = useCallback((event: WallEvent) => {
    // Every visible pane (the three seed panes + any the user splits off) gets a
    // fake shell. `paneAdded` fires once per pane that becomes visible, before the
    // pane's terminal spawns.
    if (event.type === "paneAdded") {
      shellRegistryRef.current?.ensureShell(event.id);
    }
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
            defaultThemeId={POCKET_THEME_ID}
          />
        }
      />

      <main className="fixed top-16 right-0 bottom-0 left-0 flex min-h-0 md:top-20">
        {WallModule ? (
          <WallModule.Wall
            restoredLathLayout={DESKTOP_PLAYGROUND_LAYOUT}
            initialMode="passthrough"
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

export default function PlaygroundDesktop() {
  const preferred = usePreferredPlayground();
  if (preferred === "pocket") return <DesktopPlaygroundUnavailable />;
  return <PlaygroundDesktopExperience />;
}

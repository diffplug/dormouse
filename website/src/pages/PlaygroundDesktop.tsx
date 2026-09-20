import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import { PlaceToPaste } from "../components/PlaceToPaste";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { DESKTOP_TUTORIAL_PROFILE } from "../lib/tut-items";
import { TutorialState } from "../lib/tutorial-state";
import { TutDetector } from "../lib/tut-detector";
import {
  BUSY_DEMO_INTERVAL_MS,
  TutRunner,
} from "../lib/tut-runner";
import { ChangelogRunner } from "../lib/changelog-runner";
import { getPreferredPlayground, POCKET_PLAYGROUND_PATH, usePreferredPlayground } from "../lib/playground-routing";
import {
  DESKTOP_PANES,
  DESKTOP_PLAYGROUND_LAYOUT,
  PANE_BOXED,
  PANE_SPLASH,
  type DesktopPaneSpec,
} from "../lib/playground-desktop-layout";
import { SITE_LINK_CLASS } from "../components/site-tokens";
import { WEBSITE_DEFAULT_THEME_ID } from "../lib/website-theme";

type FakePtyAdapter = import("dormouse-lib/lib/platform/fake-adapter").FakePtyAdapter;
type WallEvent = import("dormouse-lib/components/Wall").WallEvent;

/** The two panes the alert section drives; the third hosts the runner itself. */
const ALERT_DEMO_PANES = [PANE_BOXED, PANE_SPLASH] as const;

function sendToPane(
  adapter: FakePtyAdapter,
  paneId: string,
  data: string,
): void {
  adapter.sendOutput(paneId, data);
}

/**
 * Report a foreground command the way a shell with integration would. The OSCs
 * are stripped from visible output, so this never disturbs the TUI the pane is
 * already drawing.
 */
function startFakeCommand(
  adapter: FakePtyAdapter,
  paneId: string,
  commandLine: string,
): void {
  sendToPane(adapter, paneId, `\x1b]633;E;${commandLine}\x07\x1b]633;C\x07`);
}

function finishFakeCommand(
  adapter: FakePtyAdapter,
  paneId: string,
): void {
  sendToPane(adapter, paneId, "\x1b]633;D;0\x07");
}

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
            className={SITE_LINK_CLASS}
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
  // The navbar picker used to theme this page as a side effect of its own
  // render-time restore. The picker now lives in the Settings dialog and only
  // mounts when opened, so the page restores its own theme.
  useRestoredTheme(WEBSITE_DEFAULT_THEME_ID);

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
  const busyDemoFinishTimerRef = useRef<number | null>(null);
  const demoTimersRef = useRef<number[]>([]);

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
      // Phone hydration briefly mounts this desktop prerender before reconciling media.
      if (getPreferredPlayground() === "pocket") return;
      // None of these consumes another, so load the whole bundle at once rather
      // than paying a round of module resolution each on the boot path.
      const [platform, registry, mouseSelection, themes, alertSettings, wall, scenarios, asciiSplash] = await Promise.all([
        import("dormouse-lib/lib/platform"),
        import("dormouse-lib/lib/terminal-registry"),
        import("dormouse-lib/lib/mouse-selection"),
        import("dormouse-lib/lib/themes"),
        import("dormouse-lib/lib/alert-settings"),
        import("dormouse-lib/components/Wall"),
        import("dormouse-lib/lib/platform/fake-scenarios"),
        import("../lib/ascii-splash-runner"),
        import("dormouse-lib/index.css"),
      ]);
      if (cancelled) return;

      const adapter = platform.initPlatform("fake");
      // The demo gets the notepad — its archive is the fake adapter's in-memory
      // one — but no keyboard shortcut for it: a browser tab cannot take
      // Cmd/Ctrl+N (docs/specs/notepad.md).
      adapter.browserReservesNotepadChord = true;
      registry.initAlertStateReceiver();
      adapterRef.current = adapter;

      adapter.setDefaultScenario(scenarios.SCENARIO_SHELL_PROMPT);
      // Each runner-owned pane suppresses the default shell-prompt scenario,
      // otherwise spawnPty queues a delayed `user@dormouse:~$` write that
      // would land in the runner's alt-screen and corrupt its output.
      for (const pane of DESKTOP_PANES) {
        adapter.setScenario(pane.id, { name: "none", chunks: [] });
      }

      const tutorialState = new TutorialState(DESKTOP_TUTORIAL_PROFILE.sections);
      stateRef.current = tutorialState;
      const detector = new TutDetector({
        state: tutorialState,
        activityStore: registry,
        mouseStore: mouseSelection,
        themeStore: themes,
      });
      detectorRef.current = detector;
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
              getInactivityTimeoutMs: () => alertSettings.getAlertSettings().inactivityTimeoutMs,
              // WATCHING is keyed on the running command, so the demo has to
              // report one through shell integration. Both alert panes run the
              // same fake `longtask`, which is what lets one rule light up the
              // other pane (docs/specs/alert.md).
              // No cancel of a prior run here: TutRunner ignores `s` until the
              // fake command's whole `commandMs` has elapsed, so a second call
              // cannot arrive while this pump or timer is live.
              onTriggerBusyDemo: (durationMs, commandMs) => {
                for (const paneId of ALERT_DEMO_PANES) {
                  startFakeCommand(adapter, paneId, "longtask");
                }
                // Always pump the changelog pane: it is the quiet one, so it can
                // actually go silent and ring. ascii-splash animates forever, so
                // it stays BUSY — which is a fine demo of the rule applying, but
                // it could never reach ALERT_RINGING.
                busyDemoDisposeRef.current = adapter.pumpActivity(
                  PANE_BOXED,
                  durationMs,
                  BUSY_DEMO_INTERVAL_MS,
                );
                busyDemoFinishTimerRef.current = window.setTimeout(() => {
                  busyDemoFinishTimerRef.current = null;
                  for (const paneId of ALERT_DEMO_PANES) {
                    finishFakeCommand(adapter, paneId);
                    // The pane's real program is still drawing, so put its
                    // actual command line back rather than leaving the pane
                    // looking idle.
                    shellRegistryRef.current?.ensureShell(paneId).reportRunningCommand();
                  }
                }, commandMs);
              },
              // Terminal reports need no rule at all — this is a raw OSC 777
              // notification, parsed by the same code a real PTY feeds.
              onTriggerNotifyDemo: () => {
                sendToPane(
                  adapter,
                  PANE_BOXED,
                  "\x1b]777;notify;Build finished;3 packages rebuilt\x07",
                );
              },
              // An unwatched command, so the command-exit track owns the ring:
              // the user attends the pane, leaves, and the exit rings.
              onTriggerCommandExitDemo: (durationMs) => {
                startFakeCommand(adapter, PANE_SPLASH, "slowbuild");
                demoTimersRef.current.push(
                  window.setTimeout(() => {
                    finishFakeCommand(adapter, PANE_SPLASH);
                    shellRegistryRef.current?.ensureShell(PANE_SPLASH).reportRunningCommand();
                  }, durationMs),
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
      spawnUnsubRef.current?.();
      spawnUnsubRef.current = null;
      busyDemoDisposeRef.current?.();
      busyDemoDisposeRef.current = null;
      if (busyDemoFinishTimerRef.current !== null) {
        window.clearTimeout(busyDemoFinishTimerRef.current);
        busyDemoFinishTimerRef.current = null;
      }
      for (const timer of demoTimersRef.current) window.clearTimeout(timer);
      demoTimersRef.current = [];
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
      <SiteHeader activePath="/playground" themeAware />

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

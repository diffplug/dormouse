import { useState, useEffect, useCallback, useRef } from "react";
import { Link } from "react-router";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import PlaygroundHeader from "../components/PlaygroundHeader";
import { APP_BAR_HEIGHT_PX, PANE_GUTTER_PX } from "dormouse-lib/components/design";
import { PlaceToPaste } from "../components/PlaceToPaste";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import { PlaygroundShellRegistry } from "../lib/playground-shells";
import { DESKTOP_TUTORIAL_PROFILE } from "../lib/tut-items";
import { TutorialState } from "../lib/tutorial-state";
import { TutDetector } from "../lib/tut-detector";
import { TutRunner } from "../lib/tut-runner";
import { startAlertProgram } from "../lib/alert-programs";
import { ChangelogRunner } from "../lib/changelog-runner";
import { getPreferredPlayground, POCKET_PLAYGROUND_PATH, usePreferredPlayground } from "../lib/playground-routing";
import {
  DESKTOP_PANES,
  DESKTOP_PLAYGROUND_LAYOUT,
  type DesktopPaneSpec,
} from "../lib/playground-desktop-layout";
import { SITE_LINK_CLASS } from "../components/site-tokens";
import { WEBSITE_DEFAULT_THEME_ID } from "../lib/website-theme";

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
    WorkspaceWindow: React.ComponentType<any>;
    PlaygroundTabs: React.ComponentType;
  } | null>(null);
  const [placeToPasteOpen, setPlaceToPasteOpen] = useState(false);

  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const shellRegistryRef = useRef<PlaygroundShellRegistry | null>(null);
  const detectorRef = useRef<TutDetector | null>(null);
  const stateRef = useRef<TutorialState | null>(null);
  const autoStartedRef = useRef<Set<string>>(new Set());
  const spawnUnsubRef = useRef<(() => void) | null>(null);
  const disposeFsRef = useRef<(() => void) | null>(null);

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
      const [platform, registry, mouseSelection, themes, alertSettings, alertDelivery, workspaceWindow, playgroundTabs, workspaceStore, shellDefaults, asciiSplash, playgroundFs] = await Promise.all([
        import("dormouse-lib/lib/platform"),
        import("dormouse-lib/lib/terminal-registry"),
        import("dormouse-lib/lib/mouse-selection"),
        import("dormouse-lib/lib/themes"),
        import("dormouse-lib/lib/alert-settings"),
        import("dormouse-lib/lib/alert-delivery-model"),
        import("dormouse-lib/components/WorkspaceWindow"),
        import("../components/PlaygroundTabs"),
        import("dormouse-lib/lib/workspace-store"),
        import("dormouse-lib/lib/shell-defaults"),
        import("../lib/ascii-splash-runner"),
        import("../lib/playground-fs"),
        import("dormouse-lib/index.css"),
      ]);
      if (cancelled) return;

      const adapter = platform.initPlatform("fake");
      registry.initAlertStateReceiver();
      adapterRef.current = adapter;

      // Every shell is the playground's own, which prints its prompt on spawn
      // (`PlaygroundShellRegistry`); no scenario plays. A named shell keeps a
      // Windows visitor's default from reading as `cmd`, whose Tools are refused.
      shellDefaults.setDefaultShellOpts({ shell: "/bin/fake" });
      const fsHost = playgroundFs.installPlaygroundFs(adapter);
      disposeFsRef.current = fsHost.dispose;

      const tutorialState = new TutorialState(DESKTOP_TUTORIAL_PROFILE.sections);
      stateRef.current = tutorialState;
      const detector = new TutDetector({
        state: tutorialState,
        activityStore: registry,
        mouseStore: mouseSelection,
        themeStore: themes,
        commandStore: registry,
        // The active Workspace's policy, the app default under its override,
        // so either switch credits `al-speak`.
        speechStore: {
          subscribe: (listener) => {
            const stops = [alertSettings.subscribeToAlertSettings(listener), workspaceStore.subscribeToWorkspaces(listener)];
            return () => stops.forEach((stop) => stop());
          },
          isSpeechOn: () => alertDelivery.resolveAlertDeliveryPolicy(
            alertSettings.getAlertSettings(),
            workspaceStore.getWorkspace(workspaceStore.getActiveWorkspaceId())?.alertDelivery,
          ).speakEnabled,
        },
      });
      detectorRef.current = detector;
      detector.start();

      const shellRegistry = new PlaygroundShellRegistry(
        adapter,
        (terminalId, name, args, onExit) => {
          if (name === "tutorial") {
            return new TutRunner({
              adapter,
              terminalId,
              state: tutorialState,
              onExit,
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
          const alertProgram = startAlertProgram(name, args, (data) => adapter.sendOutput(terminalId, data), onExit);
          if (alertProgram) return alertProgram;
          if (name === "dor") {
            return fsHost.startDor(terminalId, args, shellRegistry.cwdOf(terminalId) ?? fsHost.shellFs.cwd, onExit);
          }
          return null;
        },
        fsHost.shellFs,
      );
      shellRegistryRef.current = shellRegistry;

      // Seed each pane's header title as a pending shell opt — the lib applies it
      // (as a user-pin, which deriveHeader ranks above the engine fallback) when
      // the terminal first spawns, after its state reset, so nothing clobbers it.
      const paneById = new Map(DESKTOP_PANES.map((p) => [p.id, p]));
      for (const pane of DESKTOP_PANES) {
        registry.setPendingShellOpts(pane.id, { title: pane.title, shell: "/bin/fake" });
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

      // A revisit starts from one Workspace and re-seeds the L-shape rather
      // than finding the last visit's Workspaces.
      workspaceWindow.resetWorkspaceWindow();
      // A user's name, so auto-naming never retitles it from its panes' cwd.
      workspaceStore.renameWorkspace(workspaceStore.getActiveWorkspaceId(), "Playground");
      setWallModule({ WorkspaceWindow: workspaceWindow.WorkspaceWindow, PlaygroundTabs: playgroundTabs.PlaygroundTabs });
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
      disposeFsRef.current?.();
      disposeFsRef.current = null;
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
      <PlaygroundHeader tabs={WallModule ? <WallModule.PlaygroundTabs /> : null} />

      <main
        className="fixed right-0 bottom-0 left-0 flex min-h-0"
        style={{ top: APP_BAR_HEIGHT_PX + PANE_GUTTER_PX }}
      >
        {WallModule ? (
          <WallModule.WorkspaceWindow
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

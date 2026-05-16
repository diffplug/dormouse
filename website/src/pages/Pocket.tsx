import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { ShareIcon } from "@phosphor-icons/react";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import { NotifySignupForm } from "../components/NotifySignupForm";
import { MobileTerminalUi, type MobileTerminalKeyboardMode, type MobileTerminalTouchMode } from "dormouse-lib/components/MobileTerminalUi";
import { MobileWall, useMobileWallSessionItems, type MobileWallSession } from "dormouse-lib/components/MobileWall";
import { ThemePicker } from "dormouse-lib/components/ThemePicker";
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

export { Pocket as Component };

type FakePtyAdapter = import("dormouse-lib/lib/platform/fake-adapter").FakePtyAdapter;

const POCKET_PANE = "pocket-ascii-splash";
const POCKET_THEME_ID = "vscode.theme-kimbie-dark.kimbie-dark";
const POCKET_SESSIONS: MobileWallSession[] = [{ id: POCKET_PANE, title: "ascii-splash" }];

function useIsMobileViewport() {
  const [isMobile, setIsMobile] = useState(false);

  useEffect(() => {
    const media = window.matchMedia("(max-width: 767px)");
    const update = () => setIsMobile(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);

  return isMobile;
}

function usePocketTheme() {
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restoreActiveTheme(POCKET_THEME_ID);
    restoredRef.current = true;
  }
}

function PocketTerminalExperience({
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
  }, [tryAutoStart]);

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

function MobilePocketPage() {
  return (
    <main className="fixed inset-0 bg-black">
      <PocketTerminalExperience interactive fillViewport />
      <div className="absolute right-2 top-10 z-30 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)]/95 px-1.5 py-1 text-[var(--vscode-editor-foreground)] shadow-lg">
        <ThemePicker variant="standalone-appbar" defaultThemeId={POCKET_THEME_ID} />
      </div>
    </main>
  );
}

function ShareUrlButton() {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ url, title: "Dormouse Pocket" });
        return;
      } catch (err) {
        if ((err as DOMException)?.name === "AbortError") return;
      }
    }
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      window.prompt("Copy this URL to your phone:", url);
    }
  }

  return (
    <button
      type="button"
      onClick={handleShare}
      aria-label="Share this page URL"
      className="inline-flex items-center gap-1 align-[-0.2em] rounded text-[var(--color-text)]/90 transition duration-150 hover:scale-120 hover:text-[var(--color-text)]"
    >
      <ShareIcon size={22} weight="bold" />
      {copied && <span className="text-sm">copied!</span>}
    </button>
  );
}

function DesktopPocketPage() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader
        activePath="/pocket"
        style={STATIC_PAGE_HEADER_STYLE}
        controls={<ThemePicker variant="standalone-appbar" defaultThemeId={POCKET_THEME_ID} />}
      />
      <main className="mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-4 pb-10 pt-24 md:grid-cols-[minmax(0,1fr)_minmax(320px,390px)] md:px-8 md:pt-28">
        <section className="max-w-2xl">
          <h1 className="font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] text-[var(--color-text)] mb-4">
            Walk away. Keep going.
          </h1>
          <p className="mb-6 font-display text-lg text-[var(--color-caramel)]">
            Come back right now on mobile{" "}
            <ShareUrlButton />{" "}
            to try it out! (WIP)
          </p>
          <p className="mb-4 text-lg leading-relaxed opacity-70">
            Tether a terminal session to your phone over WebRTC and take a stroll — the Dormouse
            alert system buzzes you if there's anything to do. A hosted auto-pairing service comes
            later, so you can just leave and keep working, no "I'm walking away" dance.
          </p>
          <p className="mb-4 text-lg leading-relaxed opacity-70">
            Open source and free to self-host, or pay us a little bit and you can use ours. We'll discount for early adopters, so don't miss out!
          </p>
          <NotifySignupForm />
        </section>

        <section aria-label="Dormouse Pocket phone preview" className="mx-auto w-full max-w-[390px]">
          <div className="rounded-[2.4rem] border border-white/15 bg-neutral-950 p-3 shadow-[0_24px_90px_rgba(0,0,0,0.55)]">
            <div className="mx-auto mb-2 h-1.5 w-24 rounded-full bg-white/20" />
            <div className="aspect-[390/812] overflow-hidden rounded-[1.8rem] border border-white/10 bg-black">
              <div className="h-full pointer-events-none" aria-hidden="true" inert>
                <PocketTerminalExperience interactive={false} />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Pocket() {
  const isMobile = useIsMobileViewport();

  useEffect(() => {
    const className = isMobile ? "pocket-terminal-body" : "pocket-marketing-body";
    document.body.classList.add(className);
    return () => document.body.classList.remove(className);
  }, [isMobile]);

  return isMobile ? <MobilePocketPage /> : <DesktopPocketPage />;
}

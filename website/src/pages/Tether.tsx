import { useCallback, useEffect, useRef, useState, type ComponentType } from "react";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import { MobileTerminalUi } from "mouseterm-lib/components/MobileTerminalUi";
import { restoreActiveTheme } from "mouseterm-lib/lib/themes";

export { Tether as Component };

type FakePtyAdapter = import("mouseterm-lib/lib/platform/fake-adapter").FakePtyAdapter;
type AsciiSplashRunner = import("../lib/ascii-splash-runner").AsciiSplashRunner;

const TETHER_PANE = "tether-ascii-splash";
const TETHER_THEME_ID = "vscode.theme-kimbie-dark.kimbie-dark";

interface WallModule {
  Wall: ComponentType<any>;
}

interface DockviewApiLike {
  getPanel(id: string): { api: { setTitle(title: string): void; setActive(): void } } | undefined;
}

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

function useTetherTheme() {
  const restoredRef = useRef(false);
  if (!restoredRef.current) {
    restoreActiveTheme(TETHER_THEME_ID);
    restoredRef.current = true;
  }
}

function TetherTerminalExperience({
  interactive,
  fillViewport = false,
}: {
  interactive: boolean;
  fillViewport?: boolean;
}) {
  useTetherTheme();
  const [WallModule, setWallModule] = useState<WallModule | null>(null);
  const adapterRef = useRef<FakePtyAdapter | null>(null);
  const runnerRef = useRef<AsciiSplashRunner | null>(null);
  const restartingRef = useRef<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function loadWall() {
      const platform = await import("mouseterm-lib/lib/platform");
      const registry = await import("mouseterm-lib/lib/terminal-registry");
      const wall = await import("mouseterm-lib/components/Wall");
      const asciiSplash = await import("../lib/ascii-splash-runner");
      await import("mouseterm-lib/index.css");
      if (cancelled) return;

      const adapter = platform.initPlatform("fake");
      registry.disposeAllSessions();
      adapter.reset();
      registry.initAlertStateReceiver();
      adapterRef.current = adapter;
      adapter.clearDefaultScenario();
      adapter.setScenario(TETHER_PANE, { name: "none", chunks: [] });

      const startRunner = () => {
        if (cancelled || runnerRef.current || !adapter.hasPty(TETHER_PANE)) return;
        const runner = new asciiSplash.AsciiSplashRunner({
          adapter,
          terminalId: TETHER_PANE,
          args: [],
          onExit: () => {
            runnerRef.current = null;
            if (cancelled) return;
            restartingRef.current = window.setTimeout(() => {
              restartingRef.current = null;
              startRunner();
            }, 120);
          },
        });
        runnerRef.current = runner;
        runner.start();
      };

      adapter.setInputHandler(TETHER_PANE, (data) => {
        runnerRef.current?.handleInput(data);
      });

      const unsubscribeSpawn = adapter.onPtySpawn(({ id }) => {
        if (id === TETHER_PANE) startRunner();
      });
      if (adapter.hasPty(TETHER_PANE)) startRunner();

      setWallModule({ Wall: wall.Wall });

      return () => {
        unsubscribeSpawn();
      };
    }

    let disposeSpawn: (() => void) | undefined;
    loadWall().then((dispose) => {
      if (cancelled) {
        dispose?.();
      } else {
        disposeSpawn = dispose;
      }
    });

    return () => {
      cancelled = true;
      disposeSpawn?.();
      if (restartingRef.current !== null) {
        window.clearTimeout(restartingRef.current);
        restartingRef.current = null;
      }
      runnerRef.current?.dispose();
      runnerRef.current = null;
      adapterRef.current?.clearInputHandler(TETHER_PANE);
    };
  }, []);

  const handleApiReady = useCallback((api: DockviewApiLike) => {
    const panel = api.getPanel(TETHER_PANE);
    if (!panel) return;
    panel.api.setTitle("ascii-splash");
    panel.api.setActive();
  }, []);

  return (
    <MobileTerminalUi
      terminal={
        WallModule ? (
          <WallModule.Wall
            initialPaneIds={[TETHER_PANE]}
            initialMode="passthrough"
            onApiReady={handleApiReady}
            showBaseboard={false}
          />
        ) : null
      }
      interactive={interactive}
      fillViewport={fillViewport}
      onSendInput={(data) => adapterRef.current?.writePty(TETHER_PANE, data)}
    />
  );
}

function MobileTetherPage() {
  return (
    <main className="fixed inset-0 bg-black">
      <TetherTerminalExperience interactive fillViewport />
    </main>
  );
}

function DesktopTetherPage() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader activePath="/tether" style={STATIC_PAGE_HEADER_STYLE} />
      <main className="mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-4 pb-10 pt-24 md:grid-cols-[minmax(0,1fr)_minmax(320px,390px)] md:px-8 md:pt-28">
        <section className="max-w-2xl">
          <h1 className="mb-6 font-display text-[clamp(2.5rem,6vw,5.5rem)] leading-none text-[var(--color-text)]">
            Coming soon: MouseTerm Tether
          </h1>
          <p className="mb-5 max-w-xl text-xl leading-relaxed opacity-75 md:text-2xl">
            Take your terminal from wherever it was (VS Code or standalone desktop) to wherever you are going
          </p>
          <p className="font-display text-lg text-[var(--color-caramel)]">
            Come back on mobile to try out the UI
          </p>
        </section>

        <section aria-label="MouseTerm Tether phone preview" className="mx-auto w-full max-w-[390px]">
          <div className="rounded-[2.4rem] border border-white/15 bg-neutral-950 p-3 shadow-[0_24px_90px_rgba(0,0,0,0.55)]">
            <div className="mx-auto mb-2 h-1.5 w-24 rounded-full bg-white/20" />
            <div className="aspect-[390/812] overflow-hidden rounded-[1.8rem] border border-white/10 bg-black">
              <div className="h-full pointer-events-none" aria-hidden="true" inert>
                <TetherTerminalExperience interactive={false} />
              </div>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
}

function Tether() {
  const isMobile = useIsMobileViewport();

  useEffect(() => {
    const className = isMobile ? "tether-terminal-body" : "tether-marketing-body";
    document.body.classList.add(className);
    return () => document.body.classList.remove(className);
  }, [isMobile]);

  return isMobile ? <MobileTetherPage /> : <DesktopTetherPage />;
}

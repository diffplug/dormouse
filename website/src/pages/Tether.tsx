import { useCallback, useEffect, useRef, useState, type ComponentType, type FormEvent } from "react";
import { CircleNotchIcon, ShareIcon } from "@phosphor-icons/react";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import { MobileTerminalUi } from "mouseterm-lib/components/MobileTerminalUi";
import { ThemePicker } from "mouseterm-lib/components/ThemePicker";
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
      <div className="absolute right-2 top-10 z-30 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)]/95 px-1.5 py-1 text-[var(--vscode-editor-foreground)] shadow-lg">
        <ThemePicker variant="standalone-appbar" defaultThemeId={TETHER_THEME_ID} />
      </div>
    </main>
  );
}

const EMAIL_REGEX =
  /^[a-zA-Z0-9.!#$%&'*+\/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)*$/;

function NotifySignupForm() {
  const [email, setEmail] = useState("");
  const [message, setMessage] = useState("");
  const [redirecting, setRedirecting] = useState(false);

  const redirectUrl = `https://nedshed.dev/subscribe?email=${encodeURIComponent(email)}`;

  function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!EMAIL_REGEX.test(email)) {
      setMessage("Please enter a valid email");
      return;
    }
    setRedirecting(true);
    window.setTimeout(() => {
      window.location.href = redirectUrl;
    }, 3000);
  }

  if (redirecting) {
    return (
      <div className="flex items-center gap-3 text-lg leading-relaxed text-[var(--color-caramel)]">
        <CircleNotchIcon className="shrink-0 animate-spin" size={28} weight="bold" />
        <p>
          Just one more click! Hit <span className="text-[var(--color-text)]/70">subscribe</span> after{" "}
          <a
            href={redirectUrl}
            className="underline underline-offset-2 hover:opacity-80"
          >
            the redirect
          </a>
          ...
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-2">
      <label htmlFor="notify-email" className="font-display text-sm opacity-50">
        Email
      </label>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-stretch">
        <input
          id="notify-email"
          type="email"
          name="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          required
          autoComplete="email"
          className="min-h-12 w-full rounded-md border border-[var(--color-text)]/50 bg-[var(--color-bg)] px-4 py-3 text-base text-[var(--color-text)]/70 placeholder:opacity-50 focus:border-[var(--color-caramel)] focus:outline-none sm:flex-1"
        />
        <button
          type="submit"
          className="min-h-12 inline-flex items-center justify-center rounded-md border border-[var(--color-caramel)] bg-[var(--color-caramel)]/15 px-6 py-3 text-base font-display text-[var(--color-caramel)] transition hover:bg-[var(--color-caramel)]/25 sm:w-auto"
        >
          Notify me when Tether ships
        </button>
      </div>
      {message && (
        <p className="text-sm text-red-400" role="alert">
          {message}
        </p>
      )}
    </form>
  );
}

function ShareUrlButton() {
  const [copied, setCopied] = useState(false);

  async function handleShare() {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ url, title: "MouseTerm Tether" });
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

function DesktopTetherPage() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader
        activePath="/tether"
        style={STATIC_PAGE_HEADER_STYLE}
        controls={<ThemePicker variant="standalone-appbar" defaultThemeId={TETHER_THEME_ID} />}
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
            Coming next: <span className="text-[var(--color-caramel)]">Tether</span>. Pair a
            terminal session to your phone over WebRTC and take a stroll, the MouseTerm alert
            system will buzz you if there's anything to do. A hosted auto-pairing service comes
            later — just leave and keep working, no "I'm walking away" dance.
          </p>
          <p className="mb-4 text-lg leading-relaxed opacity-70">
            Open source and free to self-host, or pay us a little bit and you can use ours. We'll discount for early adopters, so don't miss out!
          </p>
          <NotifySignupForm />
          <p className="mt-3 text-base leading-snug opacity-50">
            This signs you up for my personal devlog <a href="https://nedshed.dev" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">nedshed.dev</a> on Substack. The next post will be the launch post, you can unsubscribe any time.
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

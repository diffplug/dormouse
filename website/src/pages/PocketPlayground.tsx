import { useEffect } from "react";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import {
  POCKET_THEME_ID,
  PocketTerminalExperience,
} from "../components/PocketTerminalExperience";
import { NotifySignupForm } from "../components/NotifySignupForm";
import { ShareUrlButton } from "../components/ShareUrlButton";
import { ThemePicker } from "dormouse-lib/components/ThemePicker";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import { POCKET_PLAYGROUND_PATH, usePreferredPlayground } from "../lib/playground-routing";

function MobilePocketPlaygroundPage() {
  useRestoredTheme(POCKET_THEME_ID);
  return (
    <main className="fixed inset-0 bg-[var(--color-app-bg)] text-[var(--color-app-fg)]">
      <PocketTerminalExperience interactive fillViewport />
      <div className="absolute right-2 top-10 z-30 rounded border border-[var(--vscode-panel-border)] bg-[var(--vscode-editorWidget-background)]/95 px-1.5 py-1 text-[var(--vscode-editor-foreground)] shadow-lg">
        <ThemePicker variant="compact" />
      </div>
    </main>
  );
}

function DesktopPocketPlaygroundPage() {
  // Declared here rather than left to PocketTerminalExperience below: the
  // header's picker renders first and re-resolves through this fallback.
  useRestoredTheme(POCKET_THEME_ID);
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader
        activePath="/pocket"
        style={STATIC_PAGE_HEADER_STYLE}
        controls={<ThemePicker variant="compact" />}
      />
      <main className="mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-4 pb-10 pt-24 md:grid-cols-[minmax(0,1fr)_minmax(320px,390px)] md:px-8 md:pt-28">
        <section className="max-w-2xl">
          <h1 className="mb-4 font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] text-[var(--color-text)]">
            Walk away. Keep going.
          </h1>
          <p className="mb-6 font-display text-lg text-[var(--color-caramel)]">
            Come back on mobile{" "}
            <ShareUrlButton path={POCKET_PLAYGROUND_PATH} title="Dormouse Pocket" />{" "}
            to try it out! (WIP)
          </p>
          <p className="mb-4 text-lg leading-relaxed opacity-70">
            Take a terminal session to your phone and go for a stroll. Dormouse buzzes
            your phone when something needs attention, then lets you answer from Pocket.
          </p>
          <p className="mb-4 text-lg leading-relaxed opacity-70">
            Run the coordinating server yourself, or{" "}
            <a href="/hosted/#remote-control" className="text-[var(--color-caramel)] underline-offset-2 hover:underline">
              join the list for Dormouse Hosted
            </a>, where I’ll operate it for you. Your terminal still runs on your awake,
            online computer; Hosted removes the server setup and maintenance.
          </p>
          <NotifySignupForm
            buttonLabel="Join the devlog for Pocket + Hosted updates"
            announcement="Dormouse Pocket and Hosted"
          />
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

export default function PocketPlayground() {
  const preferred = usePreferredPlayground();

  useEffect(() => {
    const className = preferred === "pocket" ? "pocket-terminal-body" : "pocket-marketing-body";
    document.body.classList.add(className);
    return () => document.body.classList.remove(className);
  }, [preferred]);

  return preferred === "pocket" ? <MobilePocketPlaygroundPage /> : <DesktopPocketPlaygroundPage />;
}

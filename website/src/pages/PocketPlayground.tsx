import { useEffect } from "react";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "../components/SiteHeader";
import { PocketTerminalExperience } from "../components/PocketTerminalExperience";
import { PocketDemoPhone } from "../components/pocket-demo/PocketDemoPhone";
import { DOCS_THEME_ID } from "dormouse-lib/site/docs-theme";
import { NotifySignupForm } from "../components/NotifySignupForm";
import { ShareUrlButton } from "../components/ShareUrlButton";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import { POCKET_PLAYGROUND_PATH, usePreferredPlayground } from "../lib/playground-routing";
import { sitePath } from "../lib/site-meta";
import { HOSTED_REFS, withHostedRef } from "dormouse-lib/lib/hosted-links";
import { SITE_LINK_CLASS } from "../components/site-tokens";

function MobilePocketPlaygroundPage() {
  useRestoredTheme(DOCS_THEME_ID);
  return (
    <main className="fixed inset-0 bg-[var(--color-app-bg)] text-[var(--color-app-fg)]">
      {/* Its Sessions screen's Settings page picks the theme. */}
      <PocketTerminalExperience />
    </main>
  );
}

function DesktopPocketPlaygroundPage() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader activePath="/pocket" style={STATIC_PAGE_HEADER_STYLE} />
      <main className="mx-auto grid min-h-screen max-w-6xl items-center gap-10 px-4 pb-10 pt-24 md:grid-cols-[minmax(320px,390px)_minmax(0,1fr)] md:px-8 md:pt-28">
        <section className="max-w-2xl">
          <h1 className="mb-4 font-display text-[clamp(1.5rem,2.5vw+0.5rem,2.25rem)] text-[var(--color-text)]">
            Walk away. Keep going.
          </h1>
          <p className="mb-6 font-display text-lg text-[var(--color-caramel)]">
            Come back on mobile{" "}
            <ShareUrlButton path={POCKET_PLAYGROUND_PATH} title="Dormouse Pocket" />{" "}
            to try it out!
          </p>
          <p className="mb-4 text-lg leading-relaxed opacity-70">
            Take a terminal session to your phone and go for a stroll. Dormouse buzzes
            your phone when something needs attention, then lets you answer from Pocket.
          </p>
          <p className="mb-4 text-lg leading-relaxed opacity-70">
            Run your own Relay, or{" "}
            <a href={withHostedRef(sitePath("/hosted"), HOSTED_REFS.pocketPlayground, "remote-control")} className={SITE_LINK_CLASS}>
              use the Hosted Relay
            </a>{" "}
            and let me run it for you. Your terminal still runs on your awake, online
            computer; Hosted removes the server setup and maintenance.
          </p>
          <NotifySignupForm
            buttonLabel="Email me Pocket + Hosted news"
            announcement="Dormouse Pocket and Hosted"
          />
        </section>

        <PocketDemoPhone className="mx-auto md:order-first" />
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

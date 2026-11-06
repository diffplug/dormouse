import type { MetaArgs } from "react-router";
import SiteHeader from "../components/SiteHeader";
import { siteMeta, sitePath } from "../lib/site-meta";

/**
 * Where the email list's confirmation link lands: the list provider redirects
 * here once a signup is confirmed (its "use your own landing page" setting), so
 * nobody reaches it from search.
 */
export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "You're on the list — Dormouse",
    description: "Your Dormouse email signup is confirmed.",
    indexable: false,
  });
}

export default function Subscribed() {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader />
      <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-32 pb-24 md:px-6">
        <h1 className="font-display text-[clamp(1.75rem,3vw+0.75rem,2.75rem)]">You’re on the list.</h1>
        <p className="text-lg leading-relaxed text-[var(--color-text)]/70">
          You’ll get an email when Dormouse Pocket and Hosted launch.
        </p>
        <p className="text-lg leading-relaxed text-[var(--color-text)]/70">
          Until then, Dormouse runs right here in your browser.
        </p>
        <a
          href={sitePath("/playground")}
          className="mt-2 inline-flex min-h-12 items-center justify-center self-start rounded-md border border-[var(--color-caramel)] bg-[var(--color-caramel)]/15 px-6 py-3 font-display text-base text-[var(--color-caramel)] transition hover:bg-[var(--color-caramel)]/25"
        >
          Try it in the Playground
        </a>
      </main>
    </div>
  );
}

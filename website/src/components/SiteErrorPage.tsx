import SiteHeader from "./SiteHeader";
import { sitePath } from "../lib/site-meta";

/** The site's header, one line saying what went wrong, and a way home. */
export default function SiteErrorPage({ heading }: { heading: string }) {
  return (
    <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)]">
      <SiteHeader />
      <main className="mx-auto flex max-w-2xl flex-col gap-5 px-4 pt-32 pb-24 md:px-6">
        <h1 className="font-display text-[clamp(1.75rem,3vw+0.75rem,2.75rem)]">{heading}</h1>
        <a href={sitePath("/")} className="text-lg text-[var(--color-caramel)] underline underline-offset-4">
          Go to the Dormouse home page
        </a>
      </main>
    </div>
  );
}

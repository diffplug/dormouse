import type { ReactNode } from "react";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "./SiteHeader";
import { BODY_TEXT_CLASS, LINK_CLASS, MUTED_TEXT_CLASS } from "./docs-tokens";
import { sitePath } from "../lib/site-meta";

export type PolicySection = { id: string; title: string; body: ReactNode };

export default function HostedPolicyLayout({ path, title, sections }: {
  path: string;
  title: string;
  sections: PolicySection[];
}) {
  return (
    <>
      <SiteHeader activePath={path} style={STATIC_PAGE_HEADER_STYLE} prelaunch />
      <div className="min-h-screen bg-[var(--color-bg)] px-4 pt-28 pb-12 text-[var(--color-text)] md:px-6 md:pt-36">
        <main className="mx-auto max-w-3xl">
          <p className={`mb-3 font-display text-sm ${MUTED_TEXT_CLASS}`}>Dormouse Hosted</p>
          <h1 className="mb-4 font-display text-[clamp(1.75rem,3vw+0.5rem,2.5rem)]">{title}</h1>
          <p className={`mb-12 ${MUTED_TEXT_CLASS}`}>
            Draft for paid launch — not yet effective. Last updated <time dateTime="2026-10-07">October 7, 2026</time>.
            {" "}The effective date will be announced before these policies take effect.
          </p>
          {sections.map(({ id, title, body }) => (
            <section key={id} aria-labelledby={id} className="mb-10">
              <h2 id={id} className="mb-3 scroll-mt-24 font-display text-2xl">{title}</h2>
              <div className={`${BODY_TEXT_CLASS} space-y-4`}>{body}</div>
            </section>
          ))}
        </main>
        <footer className="mx-auto mt-12 max-w-3xl border-t border-[var(--color-text)]/20 pt-6">
          <nav aria-label="Hosted policies" className="flex flex-wrap gap-x-6 gap-y-3">
            <a className={LINK_CLASS} href={sitePath("/hosted")}>About Dormouse Hosted</a>
            <a className={LINK_CLASS} href={sitePath("/privacy")} aria-current={path === "/privacy" ? "page" : undefined}>Privacy</a>
            <a className={LINK_CLASS} href={sitePath("/terms")} aria-current={path === "/terms" ? "page" : undefined}>Terms</a>
            <a className={LINK_CLASS} href="https://hosted.dormouse.sh">Your account</a>
          </nav>
        </footer>
      </div>
    </>
  );
}

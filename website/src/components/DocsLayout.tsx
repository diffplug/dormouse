/**
 * Shared chrome for the public reference pages: site header, sticky table of
 * contents, and footer.
 *
 * See docs/specs/website-docs.md -> reference page chrome.
 */
import { useEffect, type ReactNode } from "react";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import SiteHeader from "./SiteHeader";
import DocsThemeControl from "./DocsThemeControl";
import { ACCENT_HOVER_TEXT_CLASS } from "./docs-tokens";
import { DOCS_PAGES, type TocEntry } from "../lib/docs-pages";
import { DOCS_THEME_ID } from "../lib/docs-theme";

/** Repaints the site's own tokens from the picked theme; see index.css. */
const THEMED_BODY_CLASS = "docs-themed";

/** The header is translucent over the page, so it takes the theme's own
 *  widget background rather than the site's near-black. */
const DOCS_HEADER_STYLE: React.CSSProperties = {
  background: "color-mix(in srgb, var(--color-bg) 85%, transparent)",
  backdropFilter: "blur(12px)",
};

function TocList({ entries, nested = false }: { entries: TocEntry[]; nested?: boolean }) {
  if (entries.length === 0) return null;
  return (
    <ul className={nested ? "mt-1 space-y-1 border-l border-[var(--color-text)]/15 pl-3" : "space-y-2"}>
      {entries.map((entry) => (
        <li key={entry.id}>
          <a
            href={`#${entry.id}`}
            className={`block text-sm opacity-70 hover:opacity-100 ${ACCENT_HOVER_TEXT_CLASS}`}
          >
            {entry.text}
          </a>
          <TocList entries={entry.children} nested />
        </li>
      ))}
    </ul>
  );
}

export default function DocsLayout({
  activePath,
  title,
  intro,
  toc,
  children,
}: {
  activePath: string;
  title: string;
  intro?: ReactNode;
  toc: TocEntry[];
  children: ReactNode;
}) {
  // These pages are long-form reading, so they follow the reader's theme
  // rather than the site's black (docs/specs/website-docs.md).
  useRestoredTheme(DOCS_THEME_ID);
  useEffect(() => {
    document.body.classList.add(THEMED_BODY_CLASS);
    return () => document.body.classList.remove(THEMED_BODY_CLASS);
  }, []);

  return (
    <>
      <SiteHeader activePath={activePath} style={DOCS_HEADER_STYLE} />

      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] pt-24 pb-16">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          <h1 className="font-display text-[clamp(1.75rem,3vw+0.5rem,2.5rem)] mb-2">{title}</h1>
          {intro && <div className="mb-8 text-lg opacity-70">{intro}</div>}

          <div className="grid gap-10 lg:grid-cols-[1fr_15rem] lg:gap-14">
            <main className="min-w-0">{children}</main>

            <aside className="order-first lg:order-last">
              <nav aria-label="On this page" className="lg:sticky lg:top-24">
                <div className="mb-3 font-display text-sm uppercase tracking-wide opacity-50">
                  On this page
                </div>
                <TocList entries={toc} />
              </nav>
            </aside>
          </div>

          <footer className="mt-16 border-t border-[var(--color-text)]/20 pt-8 text-sm opacity-60">
            <div className="flex flex-wrap gap-x-6 gap-y-2">
              {DOCS_PAGES.map((page) => (
                <a key={page.path} href={page.path} className="hover:underline">
                  {page.label}
                </a>
              ))}
              <a
                href="https://github.com/diffplug/dormouse/issues"
                className="hover:underline"
                target="_blank"
                rel="noopener noreferrer"
              >
                Report an issue
              </a>
              <a href="/supply-chain" className="hover:underline">Supply chain</a>
            </div>
          </footer>
        </div>
      </div>

      <DocsThemeControl />
    </>
  );
}

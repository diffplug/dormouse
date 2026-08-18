/**
 * Shared chrome for the three public docs pages: site header, breadcrumb,
 * sticky table of contents, and footer.
 *
 * See docs/specs/website-docs.md -> /docs rendering contract, items 2 and 5.
 */
import type { ReactNode } from "react";
import SiteHeader, { STATIC_PAGE_HEADER_STYLE } from "./SiteHeader";

export type TocEntry = { id: string; text: string; children: TocEntry[] };

function TocList({ entries, nested = false }: { entries: TocEntry[]; nested?: boolean }) {
  if (entries.length === 0) return null;
  return (
    <ul className={nested ? "mt-1 space-y-1 border-l border-[var(--color-text)]/15 pl-3" : "space-y-2"}>
      {entries.map((entry) => (
        <li key={entry.id}>
          <a
            href={`#${entry.id}`}
            className="block text-sm opacity-70 hover:opacity-100 hover:text-[var(--color-caramel)]"
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
  breadcrumb,
  toc,
  children,
}: {
  activePath: string;
  title: string;
  intro?: ReactNode;
  /** Trail above the title, e.g. Docs / CLI reference. Omit on /docs itself. */
  breadcrumb?: { href: string; label: string }[];
  toc: TocEntry[];
  children: ReactNode;
}) {
  return (
    <>
      <SiteHeader activePath={activePath} style={STATIC_PAGE_HEADER_STYLE} />

      <div className="min-h-screen bg-[var(--color-bg)] text-[var(--color-text)] pt-24 pb-16">
        <div className="mx-auto max-w-6xl px-4 md:px-6">
          {breadcrumb && breadcrumb.length > 0 && (
            <nav aria-label="Breadcrumb" className="mb-3 text-sm opacity-60">
              {breadcrumb.map((crumb, i) => (
                <span key={crumb.href}>
                  {i > 0 && <span className="mx-2">/</span>}
                  <a href={crumb.href} className="hover:text-[var(--color-caramel)] hover:underline underline-offset-2">
                    {crumb.label}
                  </a>
                </span>
              ))}
            </nav>
          )}

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
              <a href="/docs" className="hover:underline">Documentation</a>
              <a href="/docs/dor" className="hover:underline">CLI reference</a>
              <a href="/docs/agent-skill" className="hover:underline">Agent skill</a>
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
    </>
  );
}

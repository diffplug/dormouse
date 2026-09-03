/**
 * Shared chrome for every page in the docs section: site header, the left
 * navigation rail, and prev/next.
 *
 * The rail lists all of `DOCS_PAGES` and nests the current page's own sections
 * under it, so a reader can move between pages and within one from the same
 * control. There is no separate "on this page" — one rail, not two.
 *
 * See docs/specs/website-docs.md -> Reference page chrome.
 */
import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import { ListIcon, XIcon } from "@phosphor-icons/react";
import { useRestoredTheme } from "dormouse-lib/lib/themes";
import SiteHeader from "./SiteHeader";
import { ACCENT_TEXT_CLASS, MUTED_ACCENT_LINK_CLASS, TOC_INDENT_CLASS } from "./docs-tokens";
import { DOCS_PAGES, docsRailPosition, type DocsPage, type TocEntry } from "../lib/docs-pages";
import { DOCS_THEME_ID } from "../lib/docs-theme";

/** Nothing needs the floating picker at first paint, and it pulls the theme
 *  picker chunk with it. Deferred, that weight leaves every docs page's
 *  critical path — including /changelog/after, which the standalone updater
 *  opens and which is SPA-served, so its chunks arrive as a waterfall. */
const DocsThemeControl = lazy(() => import("./DocsThemeControl"));

/**
 * Renders nothing if its child fails to load.
 *
 * **Must** wrap anything lazily imported here. A reader holding cached HTML
 * across a redeploy requests a hashed chunk that no longer exists; without
 * this the rejected import throws through `Suspense` to the route boundary and
 * replaces the whole article — with a floating colour picker as the cause.
 */
class OptionalChunk extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    return this.state.failed ? null : this.props.children;
  }
}

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
    <ul className={nested ? `mt-1 space-y-1 ${TOC_INDENT_CLASS}` : "space-y-1"}>
      {entries.map((entry) => (
        <li key={entry.id}>
          <a
            href={`#${entry.id}`}
            className={`block py-0.5 text-sm ${MUTED_ACCENT_LINK_CLASS}`}
          >
            {entry.text}
          </a>
          <TocList entries={entry.children} nested />
        </li>
      ))}
    </ul>
  );
}

/**
 * The rail's contents, shared by the sticky sidebar and the mobile drawer.
 *
 * The current page's sections are the only ones expanded — every page's
 * headings at once would bury the entries that let a reader leave the
 * page they are on.
 *
 * Sizing is the caller's: the page list never shrinks, and the expanded
 * sections scroll within whatever height is left. So everything shows when it
 * fits, and when it does not the page list stays reachable while the sections
 * give up the space.
 */
function DocsNav({
  activePath,
  toc,
  className,
}: {
  activePath: string;
  toc: TocEntry[];
  className?: string;
}) {
  return (
    <nav aria-label="Documentation" className={className}>
    <ul className="flex min-h-0 flex-col gap-1">
      {DOCS_PAGES.map((page) => {
        const active = page.path === activePath;
        return (
          <li key={page.path} className={active ? "flex min-h-0 flex-col" : "shrink-0"}>
            <a
              href={page.path}
              aria-current={active ? "page" : undefined}
              className={`block shrink-0 py-1 font-display text-sm ${
                active ? ACCENT_TEXT_CLASS : MUTED_ACCENT_LINK_CLASS
              }`}
            >
              {page.label}
            </a>
            {active && toc.length > 0 ? (
              <div className={`min-h-0 overflow-y-auto pb-2 ${TOC_INDENT_CLASS}`}>
                <TocList entries={toc} />
              </div>
            ) : null}
          </li>
        );
      })}
    </ul>
    </nav>
  );
}

/** One end of the prev/next pair, or nothing when the rail has no neighbor. */
function NeighborLink({ page, rel }: { page: DocsPage | undefined; rel: "prev" | "next" }) {
  if (!page) return <span />;
  return (
    <a
      href={page.path}
      rel={rel}
      className={`group flex flex-col gap-1 ${rel === "next" ? "text-right" : ""}`}
    >
      <span className="text-xs uppercase tracking-wide opacity-50">
        {rel === "prev" ? "Previous" : "Next"}
      </span>
      <span className={`font-display group-hover:underline ${ACCENT_TEXT_CLASS}`}>{page.label}</span>
    </a>
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
  /** Defaults to this page's rail label. */
  title?: string;
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

  const [navOpen, setNavOpen] = useState(false);
  useEffect(() => {
    if (!navOpen) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setNavOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [navOpen]);

  const { current, prev, next } = docsRailPosition(activePath);
  // Three of five pages name themselves exactly as the rail does; the two that
  // differ pass their own, so the rail label stays the one owner of the rest.
  const heading = title ?? current?.label ?? "";

  return (
    <>
      <SiteHeader activePath={activePath} style={DOCS_HEADER_STYLE} />

      <div className="min-h-screen bg-[var(--color-bg)] pt-16 pb-16 text-[var(--color-text)] md:pt-20">
        {/* Narrow screens get the rail on demand: the docs are a small part of
            a phone visit, and the page list plus a page's sections above every
            article would bury the article. */}
        <div
          className="sticky top-16 z-10 border-b border-[var(--color-text)]/15 md:top-20 lg:hidden"
          style={DOCS_HEADER_STYLE}
        >
          <button
            type="button"
            aria-expanded={navOpen}
            aria-controls="docs-nav-drawer"
            onClick={() => setNavOpen((open) => !open)}
            className="flex w-full items-center gap-2 px-4 py-3 text-sm md:px-6"
          >
            {navOpen ? <XIcon size={16} weight="bold" /> : <ListIcon size={16} weight="bold" />}
            <span className="font-display opacity-70">Docs</span>
            {current ? (
              <>
                <span aria-hidden="true" className="opacity-30">/</span>
                <span className={`font-display ${ACCENT_TEXT_CLASS}`}>{current.label}</span>
              </>
            ) : null}
          </button>
          {navOpen ? (
            <div
              id="docs-nav-drawer"
              className="max-h-[70dvh] overflow-y-auto border-t border-[var(--color-text)]/15 px-4 py-4 md:px-6"
              // A section link is a same-document hash, so nothing navigates
              // and the drawer would sit over the section just jumped to.
              onClick={() => setNavOpen(false)}
            >
              <DocsNav activePath={activePath} toc={toc} />
            </div>
          ) : null}
        </div>

        <div className="mx-auto max-w-6xl px-4 pt-8 md:px-6">
          <div className="grid gap-10 lg:grid-cols-[14rem_1fr] lg:gap-14">
            <aside className="hidden lg:block" aria-hidden={navOpen ? true : undefined}>
              {/* Sticky and height-bounded so the sections below can scroll
                  while the page list stays put. */}
              <DocsNav
                activePath={activePath}
                toc={toc}
                className="sticky top-28 flex max-h-[calc(100dvh-9rem)] flex-col"
              />
            </aside>

            <div className="min-w-0">
              <h1 className="mb-2 font-display text-[clamp(1.75rem,3vw+0.5rem,2.5rem)]">{heading}</h1>
              {intro && <div className="mb-8 text-lg opacity-70">{intro}</div>}

              <main>{children}</main>

              {prev || next ? (
                <nav
                  aria-label="Previous and next page"
                  className="mt-16 grid grid-cols-2 gap-6 border-t border-[var(--color-text)]/20 pt-8 text-sm"
                >
                  <NeighborLink page={prev} rel="prev" />
                  <NeighborLink page={next} rel="next" />
                </nav>
              ) : null}

              <footer className="mt-10 text-sm opacity-60">
                <a
                  href="https://github.com/diffplug/dormouse/issues"
                  className="hover:underline"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  Report an issue
                </a>
              </footer>
            </div>
          </div>
        </div>
      </div>

      <OptionalChunk>
        <Suspense fallback={null}>
          <DocsThemeControl />
        </Suspense>
      </OptionalChunk>
    </>
  );
}

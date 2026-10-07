import { DOCS_PAGES } from "./docs-pages";
import { sitePath } from "./site-meta";

interface SiteNavLink {
  href: string;
  label: string;
  external?: boolean;
  hideOnMobile?: boolean;
  /** Paths this entry highlights for, when the href itself is never a page. */
  covers?: readonly string[];
}

/** The site's top-level links. */
export const NAV_LINKS: readonly SiteNavLink[] = [
  { href: sitePath("/playground"), label: "Playground" },
  { href: "/#download", label: "Download", hideOnMobile: true },
  // Desktop only: on a phone the docs are reached from the homepage's own
  // links, and the four marketing destinations earn the narrow bar first.
  // `/docs` only ever redirects, so it can never equal the current path — it
  // highlights for the pages it leads to instead. Left bare for that reason:
  // it is an entrypoint `website/public/_redirects` owns, not a served page,
  // so `sitePath` has nothing to point it at.
  {
    href: "/docs",
    label: "Docs",
    hideOnMobile: true,
    covers: DOCS_PAGES.map((page) => page.path),
  },
  { href: "https://github.com/diffplug/dormouse", label: "GitHub", external: true },
];

/** The links from the playground, which needs none to itself: the marketing
 *  header there and the desktop playground's title bar. */
export const NAV_LINKS_OFF_PLAYGROUND = NAV_LINKS.filter(({ href }) => href !== sitePath("/playground"));

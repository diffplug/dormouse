/**
 * The head tags that differ per page: title, description, canonical, and the
 * social cards that mirror them.
 *
 * One helper, because React Router renders only the deepest route's `meta` —
 * its tags "are not rendered on descendant routes" — so a page that wants its
 * own title replaces the whole set rather than merging with the root's. Every
 * page therefore builds its tags here, and a page with nothing of its own
 * inherits the root route's call.
 *
 * **Never** hardcode one of these in `root.tsx`'s `<head>`. A tag written there
 * is emitted before `<Meta />`, so a page that set its own title shipped two
 * `<title>` elements and every crawler read the first — the homepage's. Pinned
 * by `checkPageHeadTags` in scripts/public-docs-lint.mjs.
 */
import type { MetaDescriptor } from "react-router";

/**
 * This site's own origin.
 *
 * Mirrored by `SITE_ORIGIN` in website/scripts/generate-docs.js, which cannot
 * import this module (it is plain Node build code, and this is TypeScript the
 * browser bundle owns). `checkSiteOrigin` in scripts/public-docs-lint.mjs pins
 * the two equal.
 */
export const SITE_ORIGIN = "https://dormouse.sh";

const DEFAULT_TITLE = "Dormouse — A dormouse knows when to wake up";
const DEFAULT_DESCRIPTION =
  "So many terminals — which one needs attention? Dormouse alerts you when a build, agent, or script stops printing. Multitasking terminal for mice, no plugins, no config.";
const OG_IMAGE = `${SITE_ORIGIN}/og-image.jpg`;
const OG_IMAGE_ALT = "Dormouse — multitasking terminal for mice";

/**
 * The absolute URL a page should claim as its own.
 *
 * Trailing slash because that is what the host actually serves: a request for
 * `/supply-chain` is answered with a 308 to `/supply-chain/`, and a canonical
 * pointing at a redirect is a weaker signal than one pointing at the page.
 */
export function canonicalUrl(pathname: string): string {
  return new URL(pathname.endsWith("/") ? pathname : `${pathname}/`, SITE_ORIGIN).href;
}

/** Every per-page head tag, defaulting to the homepage's copy. */
export function siteMeta(
  pathname: string,
  page: { title?: string; description?: string } = {},
): MetaDescriptor[] {
  const title = page.title ?? DEFAULT_TITLE;
  const description = page.description ?? DEFAULT_DESCRIPTION;
  const url = canonicalUrl(pathname);
  return [
    { title },
    { name: "description", content: description },
    { tagName: "link", rel: "canonical", href: url },
    { property: "og:type", content: "website" },
    { property: "og:site_name", content: "Dormouse" },
    { property: "og:title", content: title },
    { property: "og:description", content: description },
    { property: "og:url", content: url },
    { property: "og:image", content: OG_IMAGE },
    { property: "og:image:type", content: "image/jpeg" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: OG_IMAGE_ALT },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: title },
    { name: "twitter:description", content: description },
    { name: "twitter:image", content: OG_IMAGE },
    { name: "twitter:image:alt", content: OG_IMAGE_ALT },
  ];
}

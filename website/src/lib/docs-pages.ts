/**
 * Every page in the docs section, in the order the left rail lists them.
 *
 * One owner for "which pages exist and how they are ordered". The route table,
 * the prerender list, the rail, its prev/next links, and
 * `scripts/public-docs-lint.mjs` all derive from this, because a page added to
 * one of those and missed in another ships unreachable, unrendered, or
 * unchecked.
 *
 * The changelog and the supply chain live here too. They are not generated
 * from Markdown like the three references, but a reader meets them the same
 * way — long-form material reached from the rail rather than from the
 * marketing nav.
 *
 * See docs/specs/website-docs.md -> Reference page chrome.
 */
export type DocsPage = {
  /** URL path; also the route pattern and the prerender entry. */
  path: string;
  /** Route module, resolved against the app directory (`website/src`). */
  module: string;
  /** How the left rail names it. */
  label: string;
  /**
   * Whether both READMEs are required to link this page.
   *
   * The three generated references are published off-site — the guide is a
   * Marketplace listing — so a reader who never reaches the site still needs a
   * way in. The changelog and supply chain carry no such obligation, and
   * `checkRoutesToReferences` would fail on them if they did.
   */
  published?: boolean;
};

export const DOCS_PAGES: readonly DocsPage[] = [
  { path: "/changelog", module: "./pages/Changelog.tsx", label: "Changelog" },
  { path: "/supply-chain", module: "./pages/SupplyChain.tsx", label: "Supply chain" },
  { path: "/docs/self-host", module: "./pages/SelfHostDocs.tsx", label: "Self hosting", published: true },
  { path: "/docs/agent-skill", module: "./pages/AgentSkillDocs.tsx", label: "dor agent skill", published: true },
  { path: "/docs/dor", module: "./pages/DorDocs.tsx", label: "dor CLI reference", published: true },
];

/**
 * Where `/docs` sends a reader.
 *
 * There is no index page — `/docs` is a default entrypoint, nothing more.
 * Changing this line changes where it lands, so the redirect is a 302: a 301
 * would be cached in readers' browsers past the next time we change our mind.
 */
export const DOCS_DEFAULT_PATH = "/docs/agent-skill";

/** The page before and after `path` in rail order, for prev/next links. */
export function docsNeighbors(path: string): { prev?: DocsPage; next?: DocsPage } {
  const i = DOCS_PAGES.findIndex((page) => page.path === path);
  if (i === -1) return {};
  return { prev: DOCS_PAGES[i - 1], next: DOCS_PAGES[i + 1] };
}

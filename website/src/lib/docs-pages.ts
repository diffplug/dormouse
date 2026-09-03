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
   * The off-site documents required to link this page.
   *
   * The generated references are published where a reader may never reach the
   * site — the guide is a Marketplace listing — so each names the documents
   * that must offer a way in. Running a relay server is not part of installing
   * an editor extension, so the guide carries no self-host obligation.
   *
   * Named for the obligation rather than for a state: every page here is
   * published, routed, and prerendered. `checkRoutesToReferences` reads this.
   */
  linkedFrom?: readonly ("guide" | "root-readme")[];
};

const BOTH_READMES = ["guide", "root-readme"] as const;

export const DOCS_PAGES: readonly DocsPage[] = [
  { path: "/changelog", module: "./pages/Changelog.tsx", label: "Changelog" },
  { path: "/supply-chain", module: "./pages/SupplyChain.tsx", label: "Supply chain" },
  { path: "/docs/self-host", module: "./pages/SelfHostDocs.tsx", label: "Self hosting", linkedFrom: ["root-readme"] },
  { path: "/docs/agent-skill", module: "./pages/AgentSkillDocs.tsx", label: "dor agent skill", linkedFrom: BOTH_READMES },
  { path: "/docs/dor", module: "./pages/DorDocs.tsx", label: "dor CLI reference", linkedFrom: BOTH_READMES },
];

/**
 * One heading in a page's table of contents, as the rail nests it.
 *
 * Owned here rather than by the component that renders it, because the rail is
 * the only thing that consumes both this and the page list, while five
 * unrelated producers satisfy it: `website/scripts/generate-docs.js` emits it
 * for the three generated references, and the changelog and the supply chain
 * derive it in their own page modules from the data they already render.
 */
export type TocEntry = { id: string; text: string; children: TocEntry[] };

/**
 * Where `/docs` sends a reader. Changing this line changes where it lands;
 * `website/public/_redirects` follows it, pinned by `checkDocsEntrypoint`
 * (docs/specs/website-docs.md -> Reference page chrome).
 */
export const DOCS_DEFAULT_PATH = "/docs/agent-skill";

/** Where `path` sits in the rail, and what sits either side of it. */
export function docsRailPosition(path: string): {
  current?: DocsPage;
  prev?: DocsPage;
  next?: DocsPage;
} {
  const i = DOCS_PAGES.findIndex((page) => page.path === path);
  if (i === -1) return {};
  return { current: DOCS_PAGES[i], prev: DOCS_PAGES[i - 1], next: DOCS_PAGES[i + 1] };
}

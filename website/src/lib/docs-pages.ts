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
 * from Markdown like the four references, but a reader meets them the same
 * way — long-form material reached from the rail rather than from the
 * marketing nav. The hosted-services preview is authored marketing, but
 * shares that reading surface so it sits beside the self-host alternative.
 *
 * **Must stay erasable-syntax TypeScript with no imports.**
 * `scripts/public-docs-lint.mjs` imports this module directly and relies on
 * Node's type stripping, which erases types but resolves nothing: an
 * extensionless specifier, a path alias, or a browser-only import here fails
 * `pnpm test` at its first step, far from whatever change caused it.
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
   * The documents required to link this page.
   *
   * The generated references are published where a reader may never reach the
   * site — the guide is a Marketplace listing — so each names the documents
   * that must offer a way in. Running a relay server is not part of installing
   * an editor extension, so the guide carries no self-host obligation.
   *
   * `homepage` is the on-site obligation: the marketing page is the one most
   * able to strand a reference, so a page reachable from the rail alone must
   * say so by omitting it. The changelog is the deliberate omission — readers
   * reach it from the rail and from the standalone updater's deep link, and
   * the homepage sells the product rather than its release history.
   *
   * Named for the obligation rather than for a state: every page here is
   * published, routed, and prerendered. `checkRoutesToReferences` reads this.
   */
  linkedFrom?: readonly ("guide" | "root-readme" | "homepage")[];
};

const EVERYWHERE = ["guide", "root-readme", "homepage"] as const;
const ROOT_README_AND_HOME = ["root-readme", "homepage"] as const;

export const DOCS_PAGES: readonly DocsPage[] = [
  { path: "/changelog", module: "./pages/Changelog.tsx", label: "Changelog" },
  { path: "/docs/security", module: "./pages/SecurityDocs.tsx", label: "Security", linkedFrom: ROOT_README_AND_HOME },
  { path: "/supply-chain", module: "./pages/SupplyChain.tsx", label: "Supply chain", linkedFrom: ["homepage"] },
  { path: "/docs/self-host", module: "./pages/SelfHostDocs.tsx", label: "How to self-host", linkedFrom: ROOT_README_AND_HOME },
  { path: "/hosted", module: "./pages/Hosted.tsx", label: "Pay us to host", linkedFrom: EVERYWHERE },
  { path: "/docs/agent-skill", module: "./pages/AgentSkillDocs.tsx", label: "dor agent skill", linkedFrom: EVERYWHERE },
  { path: "/docs/dor", module: "./pages/DorDocs.tsx", label: "dor CLI reference", linkedFrom: EVERYWHERE },
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

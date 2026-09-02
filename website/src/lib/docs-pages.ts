/**
 * The published reference pages, in the order they appear everywhere.
 *
 * One owner for "which references exist". The route table, the prerender list,
 * the shared docs footer, and `scripts/public-docs-lint.mjs` (which reads the
 * paths out of this file) all derive from it, because a page added to one of
 * those and missed in another ships unreachable, unrendered, or unchecked.
 *
 * See docs/specs/website-docs.md -> Reference page chrome.
 */
export const DOCS_PAGES = [
  { path: "/docs/dor", module: "./pages/DorDocs.tsx", label: "CLI reference" },
  { path: "/docs/agent-skill", module: "./pages/AgentSkillDocs.tsx", label: "Agent skill" },
  { path: "/docs/self-host", module: "./pages/SelfHostDocs.tsx", label: "Self-host" },
] as const;

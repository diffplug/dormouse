/**
 * The three security-adjacent pages: each links the other two in its own
 * prose, and the two specialized pages render their audience's rows and
 * bullets from the security spec's data rather than restating them
 * (docs/specs/website-docs.md -> `/docs/security` spec).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import security from "../data/docs.security.json";
import SecurityDocs from "./SecurityDocs";
import SelfHostDocs from "./SelfHostDocs";
import SupplyChain from "./SupplyChain";

function renderMain(element: React.ReactElement): string {
  const markup = renderToStaticMarkup(element);
  const main = markup.match(/<main\b[^>]*>(.*?)<\/main>/s)?.[1];
  expect(main).toBeDefined();
  return main!;
}

/**
 * The hrefs of a block tree's repository links — the ones that classified the
 * entry (`repoPath`), and the one thing a rendered row keeps verbatim. Site
 * links are left out: both pages link `/supply-chain` in their own prose.
 */
function repoHrefsIn(tree: unknown): string[] {
  const out: string[] = [];
  const walk = (node: unknown) => {
    if (Array.isArray(node)) return node.forEach(walk);
    if (!node || typeof node !== "object") return;
    const { type, href, repoPath } = node as { type?: string; href?: string; repoPath?: string };
    if (type === "link" && href && repoPath) out.push(href);
    Object.values(node).forEach(walk);
  };
  walk(tree);
  return out;
}

const PAGES = [
  {
    route: "/docs/security",
    element: <SecurityDocs />,
    links: ["/supply-chain", "/docs/self-host"],
  },
  {
    route: "/supply-chain",
    element: <SupplyChain />,
    audience: "supply-chain",
    links: ["/docs/security#how-the-guarantees-are-checked", "/docs/self-host#what-the-installer-does"],
  },
  {
    route: "/docs/self-host",
    element: <SelfHostDocs />,
    audience: "self-host",
    links: ["/docs/security#how-the-guarantees-are-checked", "/supply-chain"],
  },
] as const;

describe("security-adjacent documentation", () => {
  for (const page of PAGES) {
    it(`${page.route} links contextually to the other two pages`, () => {
      const main = renderMain(page.element);
      for (const href of page.links) expect(main).toContain(`href="${href}"`);
    });
  }
});

describe("specialized security guidance", () => {
  const specialized = PAGES.filter((page) => "audience" in page);
  const audiences = security.audiences as Record<
    string,
    Record<"guarantees" | "notDefended" | "knownGaps", unknown>
  >;

  for (const page of specialized) {
    it(`${page.route} renders every row and bullet of its audience, and none of the other's`, () => {
      const main = renderMain(page.element);
      const mine = audiences[page.audience];
      const theirs = Object.entries(audiences).find(([name]) => name !== page.audience)![1];
      for (const key of ["guarantees", "notDefended", "knownGaps"] as const) {
        const own = repoHrefsIn(mine[key]);
        expect(own.length).toBeGreaterThan(0);
        for (const href of own) expect(main).toContain(`href="${href}"`);
        for (const href of repoHrefsIn(theirs[key])) {
          if (!own.includes(href)) expect(main).not.toContain(`href="${href}"`);
        }
      }
    });

    it(`${page.route} links the audit method the guarantees rest on`, () => {
      const securityLinks = [...renderMain(page.element).matchAll(/href="(\/docs\/security[^"]*)"/g)].map(
        ([, href]) => href,
      );
      expect(securityLinks).toContain("/docs/security#how-the-guarantees-are-checked");
    });
  }
});

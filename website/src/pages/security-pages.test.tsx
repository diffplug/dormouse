/**
 * The three security-adjacent pages: each links the other two in its own
 * prose, and the two specialized pages render their audience's rows and
 * bullets from the security spec's data rather than restating them
 * (docs/specs/website-docs.md -> `/security` spec).
 */
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import security from "../data/docs.security.json";
import { textOf, type InlineNode } from "../components/MarkdownDocument";
import { sitePath } from "../lib/site-meta";
import SecurityDocs from "./SecurityDocs";
import SelfHostDocs from "./SelfHostDocs";
import SupplyChain from "./SupplyChain";

function renderMain(element: React.ReactElement): string {
  const markup = renderToStaticMarkup(element);
  const main = markup.match(/<main\b[^>]*>(.*?)<\/main>/s)?.[1];
  expect(main).toBeDefined();
  return main!;
}

/** Every anchor a page offers: the `id` of everything it renders in `<main>`. */
function anchorsOf(element: React.ReactElement): string[] {
  return [...renderMain(element).matchAll(/\sid="([^"]+)"/g)].map(([, id]) => id);
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
    route: "/security",
    element: <SecurityDocs />,
    // Remote control's rows too: Hosted and one-time readers never visit /self-host.
    audiences: ["security", "self-host"],
    tagged: true,
    links: [sitePath("/supply-chain"), sitePath("/self-host")],
  },
  {
    route: "/supply-chain",
    element: <SupplyChain />,
    audiences: ["supply-chain"],
    // Split by product, with no feature table to read a tag against.
    tagged: false,
    links: [
      `${sitePath("/security")}#how-the-guarantees-are-checked`,
      `${sitePath("/self-host")}#what-the-installer-does`,
    ],
  },
  {
    route: "/self-host",
    element: <SelfHostDocs />,
    audiences: ["self-host"],
    tagged: true,
    links: [
      `${sitePath("/security")}#how-the-guarantees-are-checked`,
      sitePath("/supply-chain"),
    ],
  },
] as const;

describe("security-adjacent documentation", () => {
  for (const page of PAGES) {
    it(`${page.route} links contextually to the other two pages`, () => {
      const main = renderMain(page.element);
      for (const href of page.links) expect(main).toContain(`href="${href}"`);
    });
  }

  // `assertRouteFragments` holds a fragment into a published page against that
  // page's headings, but it walks the generated Markdown only — a link written
  // in a page component is invisible to it, and these pages write three. So
  // hold them against the anchors the page they name actually renders.
  it("a fragment into one of these pages names an anchor that page renders", () => {
    // Keyed on the served form, which is what these pages link (`sitePath`).
    const anchors = new Map(PAGES.map((page) => [sitePath(page.route), anchorsOf(page.element)]));
    const crossPage = PAGES.flatMap((page) =>
      [...renderMain(page.element).matchAll(/href="(\/[^"#]*)#([^"]+)"/g)]
        .filter(([, route]) => anchors.has(route))
        .map(([, route, fragment]) => ({ from: page.route, route, fragment })),
    );
    expect(crossPage.length).toBeGreaterThan(0);
    for (const { from, route, fragment } of crossPage) {
      expect(anchors.get(route), `${from} links ${route}#${fragment}`).toContain(fragment);
    }
  });
});

// docs/specs/website-docs.md -> `/security` spec: the two generated figures
// close the section that describes the audit, after its own text.
it("/security closes how the guarantees are checked with the canary recall and the audit index", () => {
  const main = renderMain(<SecurityDocs />);
  const heading = main.indexOf('id="how-the-guarantees-are-checked"');
  const canary = main.indexOf("Every week, a canary audits the audit.");
  const recall = main.indexOf('aria-label="Canary recall"');
  const index = main.indexOf('aria-label="Audit index"');
  expect(heading).toBeGreaterThan(0);
  expect(canary).toBeGreaterThan(heading);
  expect(recall).toBeGreaterThan(canary);
  expect(index).toBeGreaterThan(recall);
  expect(main.indexOf("<h2", heading)).toBeGreaterThan(index);
});

/** Each table in `html`: its header cells and its rows' cells, as plain text. */
function tablesIn(html: string): { header: string[]; rows: string[][] }[] {
  const text = (cell: string) =>
    cell
      .replace(/<[^>]+>/g, "")
      .replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&")
      .trim();
  const cells = (row: string, tag: string) =>
    [...row.matchAll(new RegExp(`<${tag}\\b[^>]*>(.*?)</${tag}>`, "gs"))].map(([, cell]) => text(cell));
  return [...html.matchAll(/<table\b.*?<\/table>/gs)].map(([table]) => {
    const [head, ...body] = [...table.matchAll(/<tr\b.*?<\/tr>/gs)].map(([row]) => row);
    return { header: cells(head, "th"), rows: body.map((row) => cells(row, "td")) };
  });
}

// docs/specs/website-docs.md -> `/security` spec: the feature table is the
// vocabulary every entry tags itself from, so a reader finds what they use first.
it("/security names every feature in its feature table, ahead of the guarantees", () => {
  const main = renderMain(<SecurityDocs />);
  const features = main.indexOf('id="features"');
  const guarantees = main.indexOf('id="guarantees"');
  expect(features).toBeGreaterThan(0);
  expect(guarantees).toBeGreaterThan(features);
  const [table] = tablesIn(main.slice(features, guarantees));
  expect(table.header[0]).toBe("Feature");
  expect(table.rows.map((row) => row[0].split(".")[0])).toEqual(security.features);
});

/**
 * The feature tag each undefended edge and known gap in `html` opens with, or
 * null for one that holds for every install: the bullets under each heading
 * whose anchor ends `not-defended` or `known-gaps`, up to the next heading.
 */
const bulletLeads = (html: string) =>
  [...html.matchAll(/<h\d id="[^"]*(?:not-defended|known-gaps)".*?(?=<h\d|$)/gs)].flatMap(([section]) =>
    [...section.matchAll(/<li\b[^>]*><p\b[^>]*>(<em\b[^>]*>(.*?)<\/em>)?/g)].map(([, , lead]) => lead ?? null),
  );

describe("feature tags", () => {
  for (const page of PAGES.filter((page) => !page.tagged)) {
    it(`${page.route} shows no feature tags`, () => {
      const main = renderMain(page.element);
      expect(tablesIn(main).some((table) => table.header.includes("Feature"))).toBe(false);
      expect(bulletLeads(main).filter((lead) => lead !== null)).toEqual([]);
    });
  }

  /**
   * Each guarantee row /security shows, as its cell reads there (led by the
   * section that holds it), with the features it names; none is every install.
   */
  const rowFeatures = (() => {
    const audiences = security.audiences as Record<string, { guarantees: { rows: InlineNode[][][] } }>;
    return PAGES[0].audiences
      .flatMap((name) => audiences[name].guarantees.rows)
      .map((row) => ({ cell: textOf(row[0]), features: textOf(row[1]).split(", ").filter(Boolean) }));
  })();

  it("/security groups each guarantee under every feature it names, every install first", () => {
    const main = renderMain(<SecurityDocs />);
    const section = main.slice(main.indexOf('id="guarantees"'), main.indexOf('id="how-the-guarantees-are-checked"'));
    const groups = [...section.matchAll(/<h3 id="([^"]+)".*?<\/h3>(.*?)(?=<h3|$)/gs)].map(([, id, body]) => ({ id, body }));
    const names = ["Every install", ...security.features];
    expect(groups.map((g) => g.id)).toEqual(names.map((name) => name.toLowerCase().replace(/ /g, "-")));
    for (const [i, name] of names.entries()) {
      const [table] = tablesIn(groups[i].body);
      expect(table.header).toEqual(["Guarantee", "Pinned by"]);
      const expected = rowFeatures.filter((row) => (i === 0 ? row.features.length === 0 : row.features.includes(name)));
      expect(new Set(table.rows.map((row) => row[0])), name).toEqual(new Set(expected.map((row) => row.cell)));
      expect(table.rows).toHaveLength(expected.length);
      // Each row opens with a link to the section that holds it.
      expect(groups[i].body).toMatch(/<td\b[^>]*><a href="https:\/\/github\.com\/diffplug\/dormouse\/blob\/main\/docs\/specs\/security-/);
    }
    // A row naming two features appears under both.
    expect(rowFeatures.some((row) => row.features.length > 1)).toBe(true);
  });

  for (const page of PAGES.filter((page) => page.tagged)) {
    it(`${page.route} tags each bullet with the features it concerns`, () => {
      const main = renderMain(page.element);
      const tagged = (cell: string) => {
        if (cell === "") return;
        for (const tag of cell.replace(/\.$/, "").split(", ")) expect(security.features, cell).toContain(tag);
      };
      if (page.route !== "/security") {
        const guarantees = tablesIn(main).filter((table) => table.header.includes("Feature") && table.header.includes("Guarantee"));
        expect(guarantees).toHaveLength(1);
        const column = guarantees[0].header.indexOf("Feature");
        expect(guarantees[0].rows.length).toBeGreaterThan(0);
        for (const row of guarantees[0].rows) tagged(row[column]);
      }
      const audiences = security.audiences as Record<string, Record<"notDefended" | "knownGaps", { items: unknown[] }>>;
      const bullets = page.audiences.reduce(
        (n, name) => n + audiences[name].notDefended.items.length + audiences[name].knownGaps.items.length,
        0,
      );
      const leads = bulletLeads(main);
      expect(leads).toHaveLength(bullets);
      leads.forEach((lead) => tagged(lead ?? ""));
    });
  }
});

// The weights in website/src/components/security-columns.ts key on header
// text, so a renamed column would silently fall back to content sizing.
describe("column weights", () => {
  for (const page of PAGES) {
    it(`${page.route} weights the columns of every guarantee table${page.route === "/security" ? " and the feature table" : ""}`, () => {
      const tables = [...renderMain(page.element).matchAll(/<table\b.*?<\/table>/gs)].map(([table]) => table);
      const weighted = tables.filter((table) => table.includes(">Pinned by<") || (page.route === "/security" && table.includes(">What you trust beyond this computer<")));
      expect(weighted.length).toBeGreaterThan(0);
      for (const table of weighted) expect(table).toContain("<colgroup>");
    });
  }
});

// Every repository path a guarantee is pinned by opens that file on GitHub.
describe("pinned by", () => {
  for (const page of PAGES) {
    it(`${page.route} links each path a guarantee is pinned by`, () => {
      // A code span breaks its path with <wbr>s; the cell's text is the path.
      const html = renderMain(page.element).replace(/<wbr\/>/g, "");
      const tables = [...html.matchAll(/<table\b.*?<\/table>/gs)].map(([t]) => t).filter((t) => t.includes(">Pinned by<"));
      expect(tables.length).toBeGreaterThan(0);
      const cells = tables.flatMap((table) => {
        const column = tablesIn(table)[0].header.indexOf("Pinned by");
        return [...table.matchAll(/<tr\b.*?<\/tr>/gs)].slice(1).map(([row]) => [...row.matchAll(/<td\b[^>]*>(.*?)<\/td>/gs)][column][1]);
      });
      const paths = cells.flatMap((cell) => [...cell.matchAll(/<code\b[^>]*>([^<]*\/[^<]*)<\/code>/g)].map(([, path]) => ({ cell, path })));
      expect(paths.length).toBeGreaterThan(0);
      for (const { cell, path } of paths) {
        const escaped = path.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        expect(cell).toMatch(new RegExp(`<a href="https://github\\.com/diffplug/dormouse/(blob|tree)/main/${escaped}"[^>]*><code\\b`));
      }
    });
  }
});

describe("audience pages", () => {
  const audiences = security.audiences as Record<
    string,
    Record<"guarantees" | "notDefended" | "knownGaps", unknown>
  >;

  it("places every audience the generator splits on some page", () => {
    expect([...new Set(PAGES.flatMap((page) => page.audiences))].sort()).toEqual(Object.keys(audiences).sort());
  });

  for (const page of PAGES) {
    it(`${page.route} renders every row and bullet of its audiences, and none of the others'`, () => {
      const main = renderMain(page.element);
      const mine = page.audiences.map((name) => audiences[name]);
      const others = Object.entries(audiences)
        .filter(([name]) => !(page.audiences as readonly string[]).includes(name))
        .map(([, sections]) => sections);
      // The umbrella's own paragraphs link the specs too ("Every pull request
      // … Disclosure"), and its audit index links every audited section; only
      // its rows and bullets are audience-scoped.
      const prose =
        page.route === "/security"
          ? [
              ...repoHrefsIn((security.pageBlocks as { type: string }[]).filter((b) => b.type === "paragraph")),
              ...security.auditIndex.domains.flatMap((d) => d.specs.flatMap((s) => [s.url, ...s.sections.map((x) => x.url)])),
            ]
          : [];
      for (const key of ["guarantees", "notDefended", "knownGaps"] as const) {
        const own = mine.flatMap((sections) => repoHrefsIn(sections[key]));
        for (const href of own) expect(main).toContain(`href="${href}"`);
        for (const href of others.flatMap((sections) => repoHrefsIn(sections[key]))) {
          if (!own.includes(href) && !prose.includes(href)) expect(main).not.toContain(`href="${href}"`);
        }
      }
      for (const sections of mine) expect(repoHrefsIn(sections.guarantees).length).toBeGreaterThan(0);
    });
  }

  for (const page of PAGES.filter((page) => page.route !== "/security")) {
    it(`${page.route} links the audit method the guarantees rest on`, () => {
      const securityLinks = [...renderMain(page.element).matchAll(/href="(\/security[^"]*)"/g)].map(
        ([, href]) => href,
      );
      expect(securityLinks).toContain(`${sitePath("/security")}#how-the-guarantees-are-checked`);
    });
  }
});

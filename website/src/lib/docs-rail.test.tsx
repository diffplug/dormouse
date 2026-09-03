/**
 * The rail's one contract, checked for every page in it.
 *
 * A `TocEntry` is a link to an anchor on the page it belongs to, so every id
 * the rail names must be an id that page actually renders — nested entries
 * included. The five pages produce their entries three different ways (a
 * Markdown generator, a JSON changelog, a hand-written section list), which is
 * exactly why the check belongs here once rather than in each page's own test.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES, type TocEntry } from "./docs-pages";

import Changelog, { CHANGELOG_TOC } from "../pages/Changelog";
import SupplyChain, { SUPPLY_CHAIN_TOC } from "../pages/SupplyChain";
import SelfHostDocs from "../pages/SelfHostDocs";
import AgentSkillDocs from "../pages/AgentSkillDocs";
import DorDocs from "../pages/DorDocs";
import selfhost from "../data/docs.selfhost.json";
import skill from "../data/docs.skill.json";
import cli from "../data/docs.cli.json";

/** Every page in the rail, with the entries it hands the rail. */
const PAGES: Record<string, { element: React.ReactElement; toc: TocEntry[] }> = {
  "/changelog": { element: <Changelog />, toc: CHANGELOG_TOC },
  "/supply-chain": { element: <SupplyChain />, toc: SUPPLY_CHAIN_TOC },
  "/docs/self-host": { element: <SelfHostDocs />, toc: selfhost.toc },
  "/docs/agent-skill": { element: <AgentSkillDocs />, toc: skill.toc },
  "/docs/dor": { element: <DorDocs />, toc: cli.toc },
};

const idsIn = (entries: TocEntry[]): string[] =>
  entries.flatMap((entry) => [entry.id, ...idsIn(entry.children)]);

describe("every page in the rail", () => {
  it("is covered by this test", () => {
    // A page added to the rail without an entry here would go unchecked, and
    // the loop below would pass by testing one fewer page.
    expect(Object.keys(PAGES).sort()).toEqual(DOCS_PAGES.map((page) => page.path).sort());
  });

  for (const page of DOCS_PAGES) {
    it(`anchors every ${page.path} entry on an id the page renders`, () => {
      const { element, toc } = PAGES[page.path];
      // MemoryRouter because a page may use <Link>; the docs pages do not, but
      // the changelog does and the wrapper is harmless for the rest.
      const markup = renderToStaticMarkup(<MemoryRouter>{element}</MemoryRouter>);
      const rendered = new Set(
        [...markup.matchAll(/id="([^"]+)"/g)].map(([, id]) => id),
      );
      const ids = idsIn(toc);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) expect(rendered).toContain(id);
    });
  }
});

/**
 * The rail's one contract, checked for every page in it.
 *
 * A `TocEntry` is a link to an anchor on the page it belongs to, so every id
 * the rail names must be an id that page actually renders — nested entries
 * included. The seven pages produce their entries four different ways (a
 * Markdown generator, a JSON changelog, a hand-written section list), which is
 * exactly why the check belongs here once rather than in each page's own test.
 */
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";
import { describe, expect, it } from "vitest";
import { DOCS_PAGES, type TocEntry } from "./docs-pages";

import Changelog, { changelogToc } from "../pages/Changelog";
import changelog from "../data/changelog.json";
import SupplyChain, { SUPPLY_CHAIN_TOC } from "../pages/SupplyChain";
import SecurityDocs from "../pages/SecurityDocs";
import SelfHostDocs, { SELF_HOST_TOC } from "../pages/SelfHostDocs";
import Hosted, { HOSTED_TOC } from "../pages/Hosted";
import AgentSkillDocs from "../pages/AgentSkillDocs";
import DorDocs from "../pages/DorDocs";
import security from "../data/docs.security.json";
import selfhost from "../data/docs.selfhost.json";
import skill from "../data/docs.skill.json";
import cli from "../data/docs.cli.json";

/** Every page in the rail, with the entries it hands the rail. */
const PAGES: Record<string, { element: React.ReactElement; toc: TocEntry[] }> = {
  "/changelog": { element: <Changelog />, toc: changelogToc(changelog.releases) },
  "/docs/security": { element: <SecurityDocs />, toc: security.toc },
  "/supply-chain": { element: <SupplyChain />, toc: SUPPLY_CHAIN_TOC },
  "/docs/self-host": { element: <SelfHostDocs />, toc: SELF_HOST_TOC },
  "/hosted": { element: <Hosted />, toc: HOSTED_TOC },
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

  it("labels Hosted security as a reviewed design target, not a current guarantee", () => {
    const markup = renderToStaticMarkup(<MemoryRouter><Hosted /></MemoryRouter>);
    expect(markup).toContain("Paid hosting remains a design target pending independent review");
    expect(markup).toContain("would still see connection metadata");
    expect(markup).toContain("remote-security-model.md");
  });

  it("opens both hosting choices with the Relay boundary", () => {
    const selfHostMarkup = renderToStaticMarkup(
      <MemoryRouter><SelfHostDocs /></MemoryRouter>,
    );
    const hostedMarkup = renderToStaticMarkup(
      <MemoryRouter><Hosted /></MemoryRouter>,
    );

    for (const markup of [selfHostMarkup, hostedMarkup]) {
      expect(markup).toContain("Dormouse is just a terminal — it needs no server or hosting.");
      expect(markup).toContain("They require a Relay to");
      expect(markup).toContain("Dormouse’s remote features make no network requests");
    }
    expect(selfHostMarkup.indexOf("Dormouse is just a terminal —"))
      .toBeLessThan(selfHostMarkup.indexOf('id="security-model"'));
    expect(hostedMarkup.indexOf("Dormouse is just a terminal —"))
      .toBeLessThan(hostedMarkup.indexOf('id="remote-control"'));
    expect(selfHostMarkup).toContain("See the planned paid option");
    expect(hostedMarkup).toContain("Paid hosting remains a design target pending independent review");
  });

  it("names the two hosting choices", () => {
    expect(DOCS_PAGES.find((page) => page.path === "/docs/self-host")?.label)
      .toBe("How to self-host");
    expect(DOCS_PAGES.find((page) => page.path === "/hosted")?.label)
      .toBe("Dormouse Hosted");

    const selfHostMarkup = renderToStaticMarkup(
      <MemoryRouter><SelfHostDocs /></MemoryRouter>,
    );
    const hostedMarkup = renderToStaticMarkup(
      <MemoryRouter><Hosted /></MemoryRouter>,
    );
    expect(selfHostMarkup).toMatch(/<h1[^>]*>How to self-host<\/h1>/);
    expect(hostedMarkup).toMatch(/<h1[^>]*>Dormouse Hosted<\/h1>/);
  });

  it("keeps the changelog rail honest on the filtered route the updater opens", () => {
    // /changelog/after/:version renders only releases newer than the baseline.
    // A rail built from every release links into articles that route omits.
    const baseline = changelog.releases[2];
    const markup = renderToStaticMarkup(
      <MemoryRouter initialEntries={[`/changelog/after/${baseline.version}`]}>
        <Routes>
          <Route path="/changelog/after/:version" element={<Changelog />} />
        </Routes>
      </MemoryRouter>,
    );
    const rendered = new Set([...markup.matchAll(/id="([^"]+)"/g)].map(([, id]) => id));
    const shown = changelog.releases.slice(0, 2);
    const toc = changelogToc(shown);
    expect(toc.length).toBe(shown.length);
    for (const entry of toc) expect(rendered).toContain(entry.id);
    // And nothing older leaks in.
    expect(rendered).not.toContain(baseline.tag);
  });
});

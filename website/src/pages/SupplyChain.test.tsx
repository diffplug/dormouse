import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import npmDeps from "../data/dependencies-npm.json";
import SupplyChain, { SUPPLY_CHAIN_TOC } from "./SupplyChain";

describe("supply chain table of contents", () => {
  it("names every section heading the page renders, in page order", () => {
    // Anchors resolving is checked for every rail page in
    // website/src/lib/docs-rail.test.tsx.
    const markup = renderToStaticMarkup(<SupplyChain />);
    const rendered = [...markup.matchAll(/<h2 id="([^"]+)"[^>]*>(.*?)<\/h2>/g)].map(
      ([, id, html]) => [id, html.replace(/<[^>]+>/g, "")],
    );
    expect(SUPPLY_CHAIN_TOC.map((entry) => [entry.id, entry.text])).toEqual(rendered);
  });
});

describe("the Dormouse Hosted product", () => {
  const markup = renderToStaticMarkup(<SupplyChain />);

  it("follows the Self-hosted Relay in the rail, under its own anchor", () => {
    const ids = SUPPLY_CHAIN_TOC.map((entry) => entry.id);
    expect(ids.slice(-2)).toEqual(["relay", "hosted"]);
    expect(SUPPLY_CHAIN_TOC[SUPPLY_CHAIN_TOC.length - 1]).toMatchObject({ text: "Dormouse Hosted", children: [] });
    expect(markup).toContain('id="hosted-npm-dependencies"');
  });

  it("names the origins it covers and that none of it installs on the computer", () => {
    for (const origin of ["relay.dormouse.sh", "hosted.dormouse.sh", "voice.dormouse.sh"]) {
      expect(markup).toContain(origin);
    }
    expect(markup).toContain("none of it is installed on your computer");
  });

  it("counts its table in the summary row", () => {
    expect(npmDeps.hosted.length).toBeGreaterThan(0);
    expect(markup).toContain(
      `<div class="font-mono text-2xl">${npmDeps.hosted.length}</div><div>Dormouse Hosted</div>`,
    );
  });
});

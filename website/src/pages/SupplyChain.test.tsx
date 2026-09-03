import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
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

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import SupplyChain, { SUPPLY_CHAIN_TOC } from "./SupplyChain";

const markup = renderToStaticMarkup(<SupplyChain />);
/** Every `<h2>` the page renders, as `[id, text]`. */
const renderedHeadings = [...markup.matchAll(/<h2 id="([^"]+)"[^>]*>([^<]*)<\/h2>/g)].map(
  ([, id, text]) => [id, text] as const,
);

describe("supply chain table of contents", () => {
  it("names every section heading the page renders, in page order", () => {
    // Both come off SECTIONS, so this fails the moment one of them stops.
    expect(SUPPLY_CHAIN_TOC.map((entry) => [entry.id, entry.text])).toEqual(
      renderedHeadings.map(([id, text]) => [id, text]),
    );
  });

  it("gives each section a distinct anchor", () => {
    const ids = SUPPLY_CHAIN_TOC.map((entry) => entry.id);
    expect(ids.length).toBeGreaterThan(0);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

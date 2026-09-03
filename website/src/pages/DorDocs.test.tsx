import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DorDocs from "./DorDocs";
import cli from "../data/docs.cli.json";

const markup = renderToStaticMarkup(<DorDocs />);
/** Heading level per anchor, so the outline can be checked against the nesting. */
const headingLevel = new Map(
  [...markup.matchAll(/<h([1-6]) id="([^"]+)"/g)].map(([, level, id]) => [id, Number(level)]),
);

describe("dor CLI reference outline", () => {
  it("renders each command one heading level below the entry that nests it", () => {
    // A reader on a screen reader navigates the outline, not the rail. If the
    // commands stay `h2` peers of the `Commands` heading, the two disagree.
    // Anchors resolving is checked in website/src/lib/docs-rail.test.tsx.
    const commands = cli.toc.find((entry) => entry.id === cli.commandsHeading.id);
    expect(commands?.children.length).toBeGreaterThan(0);
    const parent = headingLevel.get(cli.commandsHeading.id);
    expect(parent).toBeDefined();
    for (const child of commands?.children ?? []) {
      expect(headingLevel.get(child.id)).toBe((parent ?? 0) + 1);
    }
  });
});

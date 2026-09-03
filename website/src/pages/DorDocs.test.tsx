import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import DorDocs from "./DorDocs";
import cli from "../data/docs.cli.json";
import { type TocEntry } from "../lib/docs-pages";

const markup = renderToStaticMarkup(<DorDocs />);
const renderedIds = [...markup.matchAll(/id="([^"]+)"/g)].map(([, id]) => id);
/** Heading level per anchor, so the outline can be checked against the nesting. */
const headingLevel = new Map(
  [...markup.matchAll(/<h([1-6]) id="([^"]+)"/g)].map(([, level, id]) => [id, Number(level)]),
);

const idsIn = (entries: TocEntry[]): string[] =>
  entries.flatMap((entry) => [entry.id, ...idsIn(entry.children)]);

describe("dor CLI reference table of contents", () => {
  it("names only anchors the page renders, nested entries included", () => {
    // The generator emits the entries; the page renders the headings. The
    // Commands parent is the one entry with no command section behind it, so
    // it is the one that can silently become a link to nowhere.
    const ids = idsIn(cli.toc);
    expect(ids).toContain(cli.commandsHeading.id);
    expect(ids.length).toBeGreaterThan(cli.commands.length);
    for (const id of ids) expect(renderedIds).toContain(id);
  });

  it("renders each command one heading level below the entry that nests it", () => {
    // A reader on a screen reader navigates the outline, not the rail. If the
    // commands stay `h2` peers of the `Commands` heading, the two disagree.
    const commands = cli.toc.find((entry) => entry.id === cli.commandsHeading.id);
    expect(commands?.children.length).toBe(cli.commands.length);
    const parent = headingLevel.get(cli.commandsHeading.id);
    expect(parent).toBeDefined();
    for (const child of commands?.children ?? []) {
      expect(headingLevel.get(child.id)).toBe((parent ?? 0) + 1);
    }
  });
});

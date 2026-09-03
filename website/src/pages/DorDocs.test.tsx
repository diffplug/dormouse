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

  it("keeps each command's own labels below that command's heading", () => {
    // Command sections carry their own `FLAGS` / `Text output:` headings. Left
    // fixed while the commands moved down a level, each command and its labels
    // become one flat run — worse than the outline the nesting replaced.
    const headings = [...markup.matchAll(/<h([1-6])((?:\s[^>]*)?)>/g)].map(([, level, attrs]) => ({
      level: Number(level),
      id: /id="([^"]+)"/.exec(attrs)?.[1],
    }));
    const commandIds = new Set(cli.commands.map((c) => c.id));
    let commandLevel;
    let checked = 0;
    for (const heading of headings) {
      if (heading.id !== undefined) {
        commandLevel = commandIds.has(heading.id) ? heading.level : undefined;
        continue;
      }
      if (commandLevel === undefined) continue;
      checked += 1;
      expect(heading.level).toBeGreaterThan(commandLevel);
    }
    expect(checked).toBeGreaterThan(0);
  });
});

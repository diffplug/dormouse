import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import Changelog, { CHANGELOG_TOC, CHANGELOG_TOC_RELEASES } from "./Changelog";
import changelog from "../data/changelog.json";

/** Every id the page puts in the document, so an entry can be checked against it. */
const renderedIds = [
  ...renderToStaticMarkup(
    <MemoryRouter>
      <Changelog />
    </MemoryRouter>,
  ).matchAll(/id="([^"]+)"/g),
].map(([, id]) => id);

describe("changelog table of contents", () => {
  it("lists the most recent releases, newest first", () => {
    const newest = changelog.releases.slice(0, CHANGELOG_TOC_RELEASES).map((r) => r.tag);
    expect(CHANGELOG_TOC.map((entry) => entry.text)).toEqual(newest);
  });

  it("caps the entries well short of what the page renders", () => {
    expect(changelog.releases.length).toBeGreaterThan(CHANGELOG_TOC_RELEASES);
    expect(CHANGELOG_TOC).toHaveLength(CHANGELOG_TOC_RELEASES);
  });

  it("anchors every entry on a release the page actually renders", () => {
    // The entries and the <article> ids are derived in different places; a
    // rail link to an id the page never emits scrolls nowhere.
    for (const entry of CHANGELOG_TOC) expect(renderedIds).toContain(entry.id);
  });
});

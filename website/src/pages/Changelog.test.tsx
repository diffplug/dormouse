import { describe, expect, it } from "vitest";
import { CHANGELOG_TOC, CHANGELOG_TOC_RELEASES } from "./Changelog";
import changelog from "../data/changelog.json";

describe("changelog table of contents", () => {
  it("caps the entries well short of what the page renders", () => {
    // The cap is the point: without it the rail would carry an entry per
    // release and dwarf the four other pages beside it. Anchors are checked
    // for every rail page in website/src/lib/docs-rail.test.tsx.
    expect(changelog.releases.length).toBeGreaterThan(CHANGELOG_TOC_RELEASES);
    expect(CHANGELOG_TOC).toHaveLength(CHANGELOG_TOC_RELEASES);
  });
});

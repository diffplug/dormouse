import { describe, expect, it } from "vitest";
import { changelogToc, CHANGELOG_TOC_RELEASES } from "./Changelog";
import changelog from "../data/changelog.json";

describe("changelog table of contents", () => {
  it("caps the entries well short of what the page renders", () => {
    // The cap is the point: without it the rail would carry an entry per
    // release and dwarf the four other pages beside it. Anchors resolving is
    // checked for every rail page in website/src/lib/docs-rail.test.tsx.
    expect(changelog.releases.length).toBeGreaterThan(CHANGELOG_TOC_RELEASES);
    expect(changelogToc(changelog.releases)).toHaveLength(CHANGELOG_TOC_RELEASES);
  });

  it("shows only what a filtered route renders, even below the cap", () => {
    const two = changelog.releases.slice(0, 2);
    expect(changelogToc(two).map((entry) => entry.id)).toEqual(two.map((r) => r.tag));
    expect(changelogToc([])).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import { parseChangelog } from "./changelog-parser.js";

describe("parseChangelog", () => {
  it("parses release headings, sections, and nested bullets", () => {
    const parsed = parseChangelog(`# Changelog

## [0.2.0] - 2026-01-02
### Added
- First item.
  - Nested detail.

### Fixed
- Second item.

## [0.1.0] - 2026-01-01
- Initial release.
`);

    expect(parsed.releases).toEqual([
      {
        version: "0.2.0",
        tag: "v0.2.0",
        date: "2026-01-02",
        sections: [
          {
            title: "Added",
            items: [
              {
                text: "First item.",
                children: [{ text: "Nested detail.", children: [] }],
              },
            ],
          },
          {
            title: "Fixed",
            items: [{ text: "Second item.", children: [] }],
          },
        ],
      },
      {
        version: "0.1.0",
        tag: "v0.1.0",
        date: "2026-01-01",
        sections: [
          {
            title: "Changes",
            items: [{ text: "Initial release.", children: [] }],
          },
        ],
      },
    ]);
  });
});

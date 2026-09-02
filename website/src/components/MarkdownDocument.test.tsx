import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownDocument, { type BlockNode } from "./MarkdownDocument";

describe("MarkdownDocument headings", () => {
  it("preserves every supported Markdown heading depth", () => {
    for (let depth = 1; depth <= 6; depth += 1) {
      const blocks: BlockNode[] = [{
        type: "heading",
        depth,
        id: `depth-${depth}`,
        text: `Depth ${depth}`,
        children: [{ type: "text", value: `Depth ${depth}` }],
      }];
      const markup = renderToStaticMarkup(<MarkdownDocument blocks={blocks} />);

      expect(markup).toMatch(new RegExp(`^<h${depth}\\b`));
      expect(markup).toContain(`</h${depth}>`);
    }
  });
});

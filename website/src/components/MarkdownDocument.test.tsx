import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import MarkdownDocument, { type BlockNode } from "./MarkdownDocument";

it("renders authored step numbers when a list resumes after prose", () => {
  const blocks: BlockNode[] = [{
    type: "list", ordered: true, start: 3,
    items: [{ type: "listItem", children: [{ type: "paragraph", children: [{ type: "text", value: "third" }] }] }],
  }];
  const markup = renderToStaticMarkup(<MarkdownDocument blocks={blocks} />);
  expect(markup).toMatch(/<ol start="3"/);
});

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

describe("inline code wrapping", () => {
  const render = (value: string) =>
    renderToStaticMarkup(
      <MarkdownDocument
        blocks={[{ type: "paragraph", children: [{ type: "code", value }] }]}
      />,
    );

  it("offers a break after every path separator", () => {
    // The 47-character path below is one unbreakable word to the line breaker,
    // and on a phone it pushed the whole article sideways rather than just
    // itself.
    const markup = render("~/Library/LaunchAgents/sh.dormouse.relay.plist");
    expect(markup).toContain("~/<wbr/>Library/<wbr/>LaunchAgents/<wbr/>sh.<wbr/>dormouse.");
  });

  it("leaves the copied text exactly as authored", () => {
    // <wbr> contributes nothing to textContent, so selecting the span still
    // yields a path a reader can paste into a shell.
    const value = "~/.config/systemd/user/dormouse-relay.service";
    const text = render(value).replace(/<[^>]*>/g, "");
    expect(text).toBe(value);
  });

  it("never offers a break inside a run of separators", () => {
    // `--watch` parted at its dashes reads as a hyphenated word break, and
    // `https://` parted at its slashes reads as a typo.
    expect(render("--watch")).toContain(">--<wbr/>watch<");
    expect(render("https://host")).toContain(">https://<wbr/>host<");
  });

  it("carries a backstop for a token with no separator to break on", () => {
    // A long hash offers nowhere to break, so the class has to allow it.
    expect(render("abcdef0123456789abcdef0123456789")).toMatch(/class="[^"]*break-words/);
  });
});

describe("renderAfterSection", () => {
  const heading = (depth: number, id: string): BlockNode => ({
    type: "heading", depth, id, text: id, children: [{ type: "text", value: id }],
  });
  const para = (value: string): BlockNode => ({ type: "paragraph", children: [{ type: "text", value }] });

  it("splices after a section's last block, its subsections included, before the next heading at its level or above", () => {
    const blocks = [heading(2, "a"), para("a1"), heading(3, "a-sub"), para("a2"), heading(2, "b"), para("b1")];
    const markup = renderToStaticMarkup(
      <MarkdownDocument blocks={blocks} renderAfterSection={(h) => <i>end {h.id}</i>} />,
    );
    const order = ["a1", "a2", "<i>end a-sub</i>", "<i>end a</i>", ">b<", "b1", "<i>end b</i>"].map((m) => markup.indexOf(m));
    for (const at of order) expect(at).toBeGreaterThan(-1);
    expect(order).toEqual([...order].sort((x, y) => x - y));
  });
});

describe("column weights", () => {
  const table: BlockNode = {
    type: "table",
    align: [null, null],
    header: [[{ type: "text", value: "Guarantee" }], [{ type: "text", value: "Pinned by" }]],
    rows: [[[{ type: "text", value: "g" }], [{ type: "text", value: "p" }]]],
  };

  it("gives each column its share of the table, by its header's text", () => {
    const markup = renderToStaticMarkup(
      <MarkdownDocument blocks={[table]} columnWeights={(header) => (header[0] === "Guarantee" ? [3, 1] : undefined)} />,
    );
    expect(markup).toContain('<colgroup><col style="width:75.00%"/><col style="width:25.00%"/></colgroup>');
    expect(markup).toMatch(/<table class="[^"]*\btable-fixed\b/);
  });

  it("leaves a table no weights name to size by its content", () => {
    for (const columnWeights of [undefined, () => undefined]) {
      const markup = renderToStaticMarkup(<MarkdownDocument blocks={[table]} columnWeights={columnWeights} />);
      expect(markup).not.toContain("<colgroup");
      expect(markup).not.toContain("table-fixed");
    }
  });
});

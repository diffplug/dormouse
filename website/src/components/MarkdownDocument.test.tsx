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

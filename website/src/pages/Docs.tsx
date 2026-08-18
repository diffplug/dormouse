/**
 * `/docs` — a web rendering of `vscode-ext/README.md`, not separately authored
 * product prose. Content and the applied structural delta both come from
 * generated data (`website/scripts/generate-docs.js`).
 */
import docs from "../data/docs.json";
import DocsLayout from "../components/DocsLayout";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";

export function meta() {
  return [
    { title: "Documentation — Dormouse" },
    {
      name: "description",
      content:
        "How to use Dormouse: tiling panes, alerts and TODOs, browser surfaces, copy/paste, keyboard shortcuts, and the dor CLI.",
    },
  ];
}

export default function Docs() {
  return (
    <DocsLayout
      activePath="/docs"
      title="Documentation"
      intro="Everything Dormouse does, in one page. The CLI and agent-skill references are linked at the bottom."
      toc={docs.guide.toc}
    >
      <MarkdownDocument blocks={docs.guide.blocks as BlockNode[]} />
    </DocsLayout>
  );
}

/**
 * `/docs/dor` — exhaustive, lossless CLI reference generated from the help
 * snapshots that `dor/test/cli-help.test.mjs` already proves match real output.
 */
import docs from "../data/docs.json";
import DocsLayout, { type TocEntry } from "../components/DocsLayout";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";
import DorCommandReference, { type CommandSection } from "../components/DorCommandReference";

export function meta() {
  return [
    { title: "dor CLI reference — Dormouse" },
    {
      name: "description",
      content:
        "Every dor command, its flags, arguments, and output, generated from the CLI's own tested help text.",
    },
  ];
}

export default function DorDocs() {
  const cli = docs.cli;

  const toc: TocEntry[] = [
    ...cli.intro.map((s) => ({ id: s.id, text: s.title, children: [] })),
    { id: cli.root.id, text: cli.root.title, children: [] },
    ...cli.commands.map((c) => ({ id: c.id, text: c.title, children: [] })),
  ];

  return (
    <DocsLayout
      activePath="/docs/dor"
      title="dor CLI reference"
      breadcrumb={[{ href: "/docs", label: "Documentation" }]}
      intro="dor is on the PATH of every terminal Dormouse launches. This page is generated from the CLI's own help output."
      toc={toc}
    >
      {cli.intro.map((section) => (
        <section key={section.id} className="mb-14">
          <h2 id={section.id} className="font-display text-2xl mb-4 scroll-mt-24">
            <a href={`#${section.id}`} className="no-underline hover:underline underline-offset-4">
              {section.title}
            </a>
          </h2>
          <MarkdownDocument blocks={section.blocks as BlockNode[]} />
        </section>
      ))}

      <DorCommandReference section={cli.root as CommandSection} />
      {cli.commands.map((section) => (
        <DorCommandReference key={section.id} section={section as CommandSection} />
      ))}
    </DocsLayout>
  );
}

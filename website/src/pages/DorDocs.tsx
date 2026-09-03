/**
 * `/docs/dor` — exhaustive, lossless CLI reference generated from the help
 * snapshots that `dor/test/cli-help.test.mjs` already proves match real output.
 */
import { type MetaArgs } from "react-router";
import { siteMeta } from "../lib/site-meta";
import cli from "../data/docs.cli.json";
import DocsLayout from "../components/DocsLayout";
import MarkdownDocument, { AnchoredHeading, type BlockNode } from "../components/MarkdownDocument";
import DorCommandReference, { type CommandSection } from "../components/DorCommandReference";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "dor CLI reference — Dormouse",
    description:
      "Every dor command, its flags, arguments, and output, generated from the CLI's own tested help text.",
  });
}

export default function DorDocs() {
  return (
    <DocsLayout
      activePath="/docs/dor"
      intro="dor is on the PATH of every terminal Dormouse launches. This page is generated from the CLI's own help output."
      toc={cli.toc}
    >
      {cli.intro.map((section) => (
        <section key={section.id} className="mb-14">
          <AnchoredHeading id={section.id} spacing="mb-4">{section.title}</AnchoredHeading>
          <MarkdownDocument blocks={section.blocks as BlockNode[]} />
        </section>
      ))}

      <DorCommandReference section={cli.root as CommandSection} />

      {/* The anchor the table of contents nests every command under. */}
      <AnchoredHeading id={cli.commandsHeading.id} spacing="mb-8">
        {cli.commandsHeading.title}
      </AnchoredHeading>
      {cli.commands.map((section) => (
        <DorCommandReference key={section.id} section={section as CommandSection} depth={3} />
      ))}
    </DocsLayout>
  );
}

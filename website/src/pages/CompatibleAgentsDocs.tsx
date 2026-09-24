import { type MetaArgs } from "react-router";
import { siteMeta } from "../lib/site-meta";
import agents from "../data/docs.agents.json";
import DocsLayout from "../components/DocsLayout";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Compatible agents — Dormouse",
    description: "CLI agents Dormouse can resume, how recovery and watching work, and how to contribute an integration.",
  });
}

export default function CompatibleAgentsDocs() {
  return (
    <DocsLayout activePath="/docs/compatible-agents" title={agents.title} toc={agents.toc}>
      <MarkdownDocument blocks={agents.blocks as BlockNode[]} />
    </DocsLayout>
  );
}

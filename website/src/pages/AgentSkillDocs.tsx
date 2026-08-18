/**
 * `/docs/agent-skill` — renders `dor/skill.md` exactly.
 *
 * Page chrome adds a table of contents, heading ids, copy buttons, and
 * contextual links into the CLI reference. Those links live in the page, never
 * in `dor/skill.md`: an older installed CLI must stay self-contained and
 * version-matched rather than pointing its instructions at the latest website.
 */
import { useState } from "react";
import docs from "../data/docs.json";
import DocsLayout from "../components/DocsLayout";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";

export function meta() {
  return [
    { title: "Agent skill — Dormouse" },
    {
      name: "description",
      content:
        "The agent skill Dormouse bundles: how an agent drives panes, terminals, and browser surfaces with dor.",
    },
  ];
}

function CopyButton({ text, children }: { text: string; children: React.ReactNode }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(
          () => {
            setCopied(true);
            setTimeout(() => setCopied(false), 1500);
          },
          () => undefined,
        );
      }}
      className="rounded-md border border-[var(--color-text)]/20 px-3 py-1.5 font-mono text-sm hover:border-[var(--color-caramel)] hover:text-[var(--color-caramel)]"
    >
      {copied ? "copied" : children}
    </button>
  );
}

/**
 * Insert the CLI reference link directly after the heading it belongs to, so
 * the skill body itself stays untouched.
 */
function withReferenceLinks(blocks: BlockNode[], references: Record<string, { href: string; label: string }>) {
  const out: { key: string; node: BlockNode | null; reference?: { href: string; label: string } }[] = [];
  blocks.forEach((node, i) => {
    out.push({ key: `b${i}`, node });
    if (node.type === "heading" && references[node.id]) {
      out.push({ key: `r${i}`, node: null, reference: references[node.id] });
    }
  });
  return out;
}

export default function AgentSkillDocs() {
  const skill = docs.skill;
  const entries = withReferenceLinks(skill.blocks as BlockNode[], skill.references);

  return (
    <DocsLayout
      activePath="/docs/agent-skill"
      title="Agent skill"
      breadcrumb={[{ href: "/docs", label: "Documentation" }]}
      intro="The operating guide Dormouse bundles for coding agents, rendered exactly as the CLI prints it."
      toc={skill.toc}
    >
      <div className="mb-8 flex flex-wrap gap-3">
        <CopyButton text="dor skill">dor skill</CopyButton>
        <CopyButton text="dor skill --install">dor skill --install</CopyButton>
      </div>

      {entries.map((entry) =>
        entry.reference ? (
          <p key={entry.key} className="-mt-2 mb-4 text-sm opacity-60">
            CLI reference:{" "}
            <a
              href={entry.reference.href}
              className="text-[var(--color-caramel)] underline-offset-2 hover:underline font-mono"
            >
              {entry.reference.label}
            </a>
          </p>
        ) : (
          <MarkdownDocument key={entry.key} blocks={[entry.node as BlockNode]} />
        ),
      )}
    </DocsLayout>
  );
}

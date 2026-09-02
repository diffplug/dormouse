/**
 * `/docs/agent-skill` — renders `dor/skill.md` exactly.
 *
 * Page chrome adds a table of contents, heading ids, copy buttons, and
 * contextual links into the CLI reference. Those links live in the page, never
 * in `dor/skill.md`: an older installed CLI must stay self-contained and
 * version-matched rather than pointing its instructions at the latest website.
 */
import { type MetaArgs } from "react-router";
import { siteMeta } from "../lib/site-meta";
import { useState } from "react";
import skill from "../data/docs.skill.json";
import DocsLayout from "../components/DocsLayout";
import { ACCENT_HOVER_BORDER_CLASS, ACCENT_HOVER_TEXT_CLASS, LINK_CLASS } from "../components/docs-tokens";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Agent skill — Dormouse",
    description:
      "The agent skill Dormouse bundles: how an agent drives panes, terminals, and browser surfaces with dor.",
  });
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
      className={`rounded-md border border-[var(--color-text)]/20 px-3 py-1.5 font-mono text-sm ${ACCENT_HOVER_BORDER_CLASS} ${ACCENT_HOVER_TEXT_CLASS}`}
    >
      {copied ? "copied" : children}
    </button>
  );
}

type Reference = { href: string; label: string };
const references: Record<string, Reference> = skill.references;

export default function AgentSkillDocs() {
  return (
    <DocsLayout
      activePath="/docs/agent-skill"
      title="Agent skill"
      intro="The operating guide Dormouse bundles for coding agents, rendered exactly as the CLI prints it."
      toc={skill.toc}
    >
      <div className="mb-8 flex flex-wrap gap-3">
        <CopyButton text="dor skill">dor skill</CopyButton>
        <CopyButton text="dor skill --install">dor skill --install</CopyButton>
      </div>

      <MarkdownDocument
        blocks={skill.blocks as BlockNode[]}
        renderAfterHeading={(heading) => {
          const reference = references[heading.id];
          if (!reference) return null;
          return (
            <p className="-mt-2 mb-4 text-sm opacity-60">
              CLI reference:{" "}
              <a href={reference.href} className={`${LINK_CLASS} font-mono`}>
                {reference.label}
              </a>
            </p>
          );
        }}
      />
    </DocsLayout>
  );
}

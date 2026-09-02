/**
 * `/docs/self-host` — the runbook half of SELF_HOST.md.
 *
 * The file is canonical in the repository: an assistant reads it there to walk
 * someone through the install, and `scripts/deploy-lint.mjs` audits the
 * Installer contract at the end of it against `deploy/local/`. The generator's
 * delta withholds that contract and the assistant-directed sections; see
 * docs/specs/website-docs.md -> `/docs/self-host` runbook.
 */
import selfhost from "../data/docs.selfhost.json";
import DocsLayout from "../components/DocsLayout";
import { LINK_CLASS } from "../components/docs-tokens";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";

export function meta() {
  return [
    { title: "Self-host — Dormouse" },
    {
      name: "description",
      content:
        "Run the Dormouse coordinating server on your own machine, reachable only from your tailnet. One installer, no database, no account.",
    },
  ];
}

const REPO_URL = "https://github.com/diffplug/dormouse";

export default function SelfHostDocs() {
  return (
    <DocsLayout
      activePath="/docs/self-host"
      title={selfhost.title}
      intro="Everything Dormouse needs for phone notifications and remote control runs on hardware you own. This is the runbook."
      toc={selfhost.toc}
    >
      <p className="mb-8 rounded-lg border border-[var(--color-caramel)]/30 bg-[var(--color-caramel)]/[0.06] p-4 leading-relaxed opacity-80">
        You do not have to follow this by hand. Clone{" "}
        <a href={REPO_URL} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
          the repository
        </a>
        , start Claude Code in it, and say{" "}
        <code className="rounded bg-[var(--color-text)]/20 px-1.5 py-0.5 font-mono text-sm">
          read @SELF_HOST.md and walk me through it
        </code>
        . It will run the checkpoints below with you, one at a time.
      </p>

      <MarkdownDocument blocks={selfhost.blocks as BlockNode[]} />
    </DocsLayout>
  );
}

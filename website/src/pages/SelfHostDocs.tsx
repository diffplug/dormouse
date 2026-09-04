/**
 * `/docs/self-host` — the runbook half of SELF_HOST.md.
 *
 * The file is canonical in the repository: an assistant reads it there to walk
 * someone through the install, and `scripts/deploy-lint.mjs` audits the
 * Installer contract at the end of it against `deploy/local/`. The generator's
 * delta withholds that contract and the assistant-directed sections; see
 * docs/specs/website-docs.md -> `/docs/self-host` runbook.
 *
 * The security model above the runbook is the security spec's own rows and
 * bullets for this audience, rendered from `docs.security.json` rather than
 * restated here — docs/specs/website-docs.md -> `/docs/security` spec.
 */
import { type MetaArgs } from "react-router";
import { siteMeta } from "../lib/site-meta";
import selfhost from "../data/docs.selfhost.json";
import security from "../data/docs.security.json";
import DocsLayout from "../components/DocsLayout";
import { CODE_CLASS, LINK_CLASS } from "../components/docs-tokens";
import MarkdownDocument, { AnchoredHeading, type BlockNode } from "../components/MarkdownDocument";
import { type TocEntry } from "../lib/docs-pages";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "How to self-host — Dormouse",
    description:
      "Run the Dormouse coordinating server on your own machine, reachable only from your tailnet. One installer, no database, no account.",
  });
}

const REPO_URL = "https://github.com/diffplug/dormouse";

const MODEL = security.audiences["self-host"];

/** The spec's subsections this page shows, each only while it has something to say. */
const MODEL_SECTIONS = [
  { id: "security-not-defended", text: "What is not defended", block: MODEL.notDefended },
  { id: "security-known-gaps", text: "Known gaps", block: MODEL.knownGaps },
].filter((section) => section.block.items.length > 0);

export const SELF_HOST_TOC: TocEntry[] = [
  {
    id: "security-model",
    text: "Security model",
    children: MODEL_SECTIONS.map(({ id, text }) => ({ id, text, children: [] })),
  },
  ...(selfhost.toc as TocEntry[]),
];

export default function SelfHostDocs() {
  return (
    <DocsLayout
      activePath="/docs/self-host"
      title="How to self-host"
      intro={
        <>
          Push notifications and phone remote control need a coordinating server. You can
          run it yourself with Tailscale today, or{" "}
          <a href="/hosted/#remote-control" className={LINK_CLASS}>
            join the devlog for updates on the planned paid Hosted option
          </a>{" "}
          that will operate it for you.
        </>
      }
      toc={SELF_HOST_TOC}
    >
      <AnchoredHeading id="security-model">Security model</AnchoredHeading>
      <p className="mb-4 text-lg leading-relaxed opacity-80">
        What remote control and this deployment guarantee, rendered from the{" "}
        <a href="/docs/security" className={LINK_CLASS}>
          security spec
        </a>{" "}
        the nightly audit reads. Each row names the spec that states the rule and what
        pins it on every build; the audit that checks all of them is described under{" "}
        <a href="/docs/security#how-the-guarantees-are-checked" className={LINK_CLASS}>
          how the guarantees are checked
        </a>
        .
      </p>
      <MarkdownDocument blocks={[MODEL.guarantees as BlockNode]} />
      {MODEL_SECTIONS.map(({ id, text, block }) => (
        <div key={id}>
          <AnchoredHeading id={id} depth={3}>
            {text}
          </AnchoredHeading>
          <MarkdownDocument blocks={[block as BlockNode]} />
        </div>
      ))}
      <p className="mb-8 text-lg leading-relaxed opacity-80">
        The exact runtime and server dependencies installed by this runbook are listed in
        the{" "}
        <a href="/supply-chain" className={LINK_CLASS}>
          supply-chain disclosure
        </a>
        .
      </p>

      <p className="mb-8 rounded-lg border border-[var(--color-caramel)]/30 bg-[var(--color-caramel)]/[0.06] p-4 leading-relaxed opacity-80">
        You do not have to follow this by hand. Clone{" "}
        <a href={REPO_URL} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
          the repository
        </a>
        , start a coding agent in it, and say{" "}
        <code className={CODE_CLASS}>
          read @SELF_HOST.md and walk me through it
        </code>
        . It will run the checkpoints below with you, one at a time.
      </p>

      <MarkdownDocument blocks={selfhost.blocks as BlockNode[]} />
    </DocsLayout>
  );
}

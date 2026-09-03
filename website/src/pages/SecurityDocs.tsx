/**
 * `/docs/security` — docs/specs/security.md, published whole.
 *
 * The file is canonical in `docs/specs/`: it is a spec, budgeted by
 * `scripts/spec-lint.mjs` and read by the nightly audit that runs against it.
 * The generator's delta withholds only the `#` title and the front matter; see
 * docs/specs/website-docs.md -> `/docs/security` spec.
 */
import { type MetaArgs } from "react-router";
import { siteMeta } from "../lib/site-meta";
import security from "../data/docs.security.json";
import DocsLayout from "../components/DocsLayout";
import { LINK_CLASS } from "../components/docs-tokens";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Security — Dormouse",
    description:
      "What Dormouse guarantees, what it does not defend, and how every guarantee is checked: build-time lints, a nightly audit, and public failure issues.",
  });
}

const SPECS_URL = "https://github.com/diffplug/dormouse/tree/main/docs/specs";

export default function SecurityDocs() {
  return (
    <DocsLayout
      activePath="/docs/security"
      title={security.title}
      intro="What Dormouse promises, what it does not, and the audit that holds it to the difference."
      toc={security.toc}
    >
      <p className="mb-8 rounded-lg border border-[var(--color-caramel)]/30 bg-[var(--color-caramel)]/[0.06] p-4 leading-relaxed opacity-80">
        This page is the spec the audit runs against, published from the
        repository — not a summary of one. It shows the guarantees for the
        local application and the release pipeline; remote control and
        self-hosting are on the{" "}
        <a href="/docs/self-host" className={LINK_CLASS}>
          self-host runbook
        </a>
        , and what reaches your machine is on the{" "}
        <a href="/supply-chain" className={LINK_CLASS}>
          supply-chain disclosure
        </a>
        . The five audited checklists behind all three live beside the spec, in{" "}
        <a href={SPECS_URL} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
          the specs directory on GitHub
        </a>
        .
      </p>

      <MarkdownDocument blocks={security.pageBlocks as BlockNode[]} />
    </DocsLayout>
  );
}

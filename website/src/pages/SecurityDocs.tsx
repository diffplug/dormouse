/**
 * `/security` — docs/specs/security.md, every section of it.
 *
 * The file is canonical in `docs/specs/`: it is a spec, budgeted by
 * `scripts/spec-lint.mjs` and read by the nightly audit that runs against it.
 * The generator's delta withholds only the `#` title and the front matter; see
 * docs/specs/website-docs.md -> `/security` spec. The page renders
 * `pageBlocks`, so the guarantees table and the two lists carry the local
 * application's, the pipeline's, and remote control's entries — the
 * supply-chain ones are on `/supply-chain`, remote control's also on
 * `/self-host`. The generator gathers the guarantees from the domain specs,
 * where each sits beside its checks; the spec file on GitHub holds every
 * undefended edge and known gap. The page adds only the two figures generated from the audit's own
 * records, and a note saying so.
 */
import { type MetaArgs } from "react-router";
import { siteMeta, sitePath } from "../lib/site-meta";
import security from "../data/docs.security.json";
import canaryRecall from "../data/canary-recall.json";
import AuditIndex from "../components/AuditIndex";
import CanaryRecall from "../components/CanaryRecall";
import DocsLayout from "../components/DocsLayout";
import { LINK_CLASS, NOTE_CLASS, NOTE_MUTED_TEXT_CLASS } from "../components/docs-tokens";
import MarkdownDocument, { type BlockNode } from "../components/MarkdownDocument";
import { securityColumnWeights } from "../components/security-columns";

export function meta({ location }: MetaArgs) {
  return siteMeta(location.pathname, {
    title: "Security — Dormouse",
    description:
      "What Dormouse guarantees, what it does not defend, and how every guarantee is checked: build-time lints, a nightly audit, a weekly canary that audits the audit, and public failure issues.",
  });
}

const SPEC_URL = "https://github.com/diffplug/dormouse/blob/main/docs/specs/security.md";
/** The section the two figures close. */
const CHECKED_ID = "how-the-guarantees-are-checked";

export default function SecurityDocs() {
  return (
    <DocsLayout activePath="/security" title={security.title} toc={security.toc}>
      <MarkdownDocument
        blocks={security.pageBlocks as BlockNode[]}
        columnWeights={securityColumnWeights}
        renderAfterSection={(heading) =>
          heading.id === CHECKED_ID ? (
            <>
              <CanaryRecall snapshot={canaryRecall} />
              <AuditIndex index={security.auditIndex} />
              <p className={`mb-8 ${NOTE_CLASS} ${NOTE_MUTED_TEXT_CLASS}`}>
                This page is{" "}
                <a href={SPEC_URL} className={LINK_CLASS} target="_blank" rel="noopener noreferrer">
                  docs/specs/security.md
                </a>
                , the spec the audit runs against, published as is, with each guarantee gathered from
                beside the checks that hold it; the two figures above are generated from the audit's
                own records. It shows the guarantees for the local
                application, remote control, and the release pipeline; what reaches your machine is in
                the{" "}
                <a href={sitePath("/supply-chain")} className={LINK_CLASS}>
                  supply-chain disclosure
                </a>
                .
              </p>
            </>
          ) : null
        }
      />
    </DocsLayout>
  );
}

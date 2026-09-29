import type { ReactNode } from "react";
import DocsLayout from "./DocsLayout";
import { AnchoredHeading } from "./MarkdownDocument";
import { BODY_TEXT_CLASS, LINK_CLASS } from "./docs-tokens";
import { sitePath } from "../lib/site-meta";

export type PolicySection = { id: string; title: string; body: ReactNode };

export default function HostedPolicyLayout({ path, title, sections }: {
  path: string;
  title: string;
  sections: PolicySection[];
}) {
  return (
    <DocsLayout
      activePath={path}
      title={title}
      intro="Draft for review · September 29, 2026 · Not yet in effect"
      toc={sections.map(({ id, title }) => ({ id, text: title, children: [] }))}
    >
      {sections.map(({ id, title, body }) => (
        <section key={id} className="mb-10">
          <AnchoredHeading id={id} spacing="mt-0 mb-3">{title}</AnchoredHeading>
          <div className={`${BODY_TEXT_CLASS} space-y-4`}>{body}</div>
        </section>
      ))}
      <nav aria-label="Hosted policies" className="flex flex-wrap gap-5">
        <a className={LINK_CLASS} href={sitePath("/hosted")}>About Dormouse Hosted</a>
        <a className={LINK_CLASS} href={sitePath("/privacy")}>Privacy</a>
        <a className={LINK_CLASS} href={sitePath("/terms")}>Terms</a>
      </nav>
    </DocsLayout>
  );
}

import { CARD_CLASS, CARD_MUTED_TEXT_CLASS, LINK_CLASS } from "./docs-tokens";

/** `auditIndex` in `website/src/data/docs.security.json`, as `auditIndex` in website/scripts/generate-docs.js builds it. */
export type AuditIndexData = {
  checks: number;
  domains: {
    name: string;
    checks: number;
    specs: { path: string; url: string; checks: number; sections: { title: string; url: string; checks: number }[] }[];
  }[];
};

const EXTERNAL = { target: "_blank", rel: "noopener noreferrer" } as const;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const fileOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);

/**
 * Everything the nightly audit checks, one row per domain: the specs its
 * scope claims and their sections, each linked to its rules on GitHub. Built
 * from the audit's own prompts and specs, so it lists what runs rather than
 * what someone remembered to write down.
 */
export default function AuditIndex({ index }: { index: AuditIndexData }) {
  const specs = index.domains.flatMap((domain) => domain.specs);
  const sections = specs.reduce((n, spec) => n + spec.sections.length, 0);
  return (
    <aside aria-label="Audit index" className={`mb-6 ${CARD_CLASS} text-[var(--color-text)]`}>
      <p className="flex flex-wrap items-baseline gap-x-2">
        <span className="font-display text-4xl">{index.checks}</span>
        <span>
          audited checks in {plural(sections, "section")} of {plural(specs.length, "spec")}
        </span>
      </p>
      <p className={`mt-2 text-sm leading-relaxed ${CARD_MUTED_TEXT_CLASS}`}>
        Each row is one domain of the nightly audit, with the specs it owns. Open one for its sections, each linked to
        its checks on GitHub.
      </p>
      <ul className="mt-4 divide-y divide-[var(--color-text)]/15 border-y border-[var(--color-text)]/15">
        {index.domains.map((domain) => (
          <li key={domain.name}>
            <details>
              <summary className="flex cursor-pointer flex-wrap items-baseline gap-x-3 py-2 focus-visible:outline-2 focus-visible:outline-[var(--docs-accent)]">
                <span className="font-mono">{domain.name}</span>
                <span className={`min-w-0 flex-1 text-sm ${CARD_MUTED_TEXT_CLASS}`}>
                  {domain.specs.map((spec) => fileOf(spec.path)).join(", ")}
                </span>
                <span className={`font-mono text-sm ${CARD_MUTED_TEXT_CLASS}`}>{plural(domain.checks, "check")}</span>
              </summary>
              <div className="space-y-3 pb-3 pl-4">
                {domain.specs.map((spec) => (
                  <div key={spec.path}>
                    <a href={spec.url} className={`font-mono text-sm ${LINK_CLASS}`} {...EXTERNAL}>
                      {fileOf(spec.path)}
                    </a>
                    <ul className="mt-1 space-y-1 text-sm">
                      {spec.sections.map((section) => (
                        <li key={section.url} className="flex items-baseline gap-3">
                          <a href={section.url} className={`min-w-0 flex-1 ${LINK_CLASS}`} {...EXTERNAL}>
                            {section.title}
                          </a>
                          <span className={`font-mono ${CARD_MUTED_TEXT_CLASS}`}>{section.checks}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                ))}
              </div>
            </details>
          </li>
        ))}
      </ul>
    </aside>
  );
}

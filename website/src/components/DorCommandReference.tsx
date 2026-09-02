/**
 * One `dor` command section on /docs/dor.
 *
 * Renders the semantic nodes the help parser produced, and keeps the original
 * help text available byte for byte in a collapsed disclosure — the parser is
 * deliberately shallow, so the exact source is always one click away.
 *
 * See docs/specs/website-docs.md -> /docs/dor reference.
 */

import { ACCENT_TEXT_CLASS, PRE_CLASS } from "./docs-tokens";

export type DefinitionGroup = { label: string; rows: { term: string; description: string }[] };
export type LabelledBlock = { label: string; body: string };

export type CommandSection = {
  id: string;
  title: string;
  invocation: string;
  usage: string[];
  prose: string[];
  definitions: DefinitionGroup[];
  blocks: LabelledBlock[];
  raw: string;
};

/** A linkable section heading, shared by the CLI page and its command sections. */
export function AnchoredHeading({ id, children, className = "mb-4" }: { id: string; children: React.ReactNode; className?: string }) {
  return (
    <h2 id={id} className={`font-display text-2xl scroll-mt-24 ${className}`}>
      <a href={`#${id}`} className="no-underline hover:underline underline-offset-4">
        {children}
      </a>
    </h2>
  );
}

export default function DorCommandReference({ section }: { section: CommandSection }) {
  return (
    <section className="mb-14">
      <AnchoredHeading id={section.id} className="mb-1">{section.title}</AnchoredHeading>
      <p className="mb-4 font-mono text-sm opacity-60">{section.invocation}</p>

      {section.usage.length > 0 && (
        <pre className={`${PRE_CLASS} mb-4`}>
          <code>{section.usage.join("\n")}</code>
        </pre>
      )}

      {section.prose.map((paragraph, i) => (
        <p key={i} className="mb-4 text-lg leading-relaxed opacity-80">
          {paragraph}
        </p>
      ))}

      {section.definitions.map((group, i) => (
        <div key={i} className="mb-6">
          <h3 className="mb-2 font-display text-sm uppercase tracking-wide opacity-50">{group.label}</h3>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <tbody>
                {group.rows.map((row, r) => (
                  <tr key={r} className="border-b border-[var(--color-text)]/10">
                    <td className={`py-2 pr-4 align-top font-mono text-sm whitespace-nowrap ${ACCENT_TEXT_CLASS}`}>
                      {row.term}
                    </td>
                    <td className="py-2 align-top opacity-80">{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {section.blocks.map((block, i) => (
        <div key={i} className="mb-4">
          <h3 className="mb-2 font-display text-sm uppercase tracking-wide opacity-50">{block.label}</h3>
          <pre className={PRE_CLASS}>
            <code>{block.body}</code>
          </pre>
        </div>
      ))}

      <details className="mt-4 rounded-lg border border-[var(--color-text)]/15">
        <summary className="cursor-pointer px-4 py-2 text-sm opacity-70 hover:opacity-100">
          Exact <code className="font-mono">{section.invocation}</code> output
        </summary>
        <pre className="overflow-x-auto border-t border-[var(--color-text)]/15 p-4 font-mono text-sm">
          <code>{section.raw}</code>
        </pre>
      </details>
    </section>
  );
}

/**
 * One `dor` command section on /docs/dor.
 *
 * Renders the semantic nodes the help parser produced, and keeps the original
 * help text available byte for byte in a collapsed disclosure — the parser is
 * deliberately shallow, so the exact source is always one click away.
 *
 * See docs/specs/website-docs.md -> /docs/dor reference.
 */

import { AnchoredHeading } from "./MarkdownDocument";
import { ACCENT_TEXT_CLASS, BODY_TEXT_CLASS, MUTED_TEXT_CLASS, PRE_CLASS, TABLE_CLASS, TABLE_ROW_CLASS, TABLE_WRAP_CLASS } from "./docs-tokens";

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

/**
 * `depth` keeps the document outline agreeing with the table of contents. The
 * eleven subcommands sit under the page's `Commands` heading, so they render as
 * `h3`; the root `dor` section is that heading's peer and keeps the default.
 *
 * **Must** push a section's own labels one level below its heading. Left fixed
 * at `h3` while the commands moved to `h3`, every `FLAGS` and `Text output:`
 * became a peer of the command it belongs to, flattening eleven commands and
 * their labels into one run for a reader navigating by heading. Pinned by
 * `website/src/pages/DorDocs.test.tsx`.
 */
export default function DorCommandReference({
  section,
  depth = 2,
}: {
  section: CommandSection;
  depth?: number;
}) {
  const LabelTag = `h${Math.min(depth + 1, 6)}` as "h3";
  return (
    <section className="mb-14">
      <AnchoredHeading id={section.id} depth={depth} spacing="mb-1">{section.title}</AnchoredHeading>
      <p className={`mb-4 font-mono text-sm ${MUTED_TEXT_CLASS}`}>{section.invocation}</p>

      {section.usage.length > 0 && (
        <pre className={`${PRE_CLASS} mb-4`}>
          <code>{section.usage.join("\n")}</code>
        </pre>
      )}

      {section.prose.map((paragraph, i) => (
        <p key={i} className={`mb-4 ${BODY_TEXT_CLASS}`}>
          {paragraph}
        </p>
      ))}

      {section.definitions.map((group, i) => (
        <div key={i} className="mb-6">
          <LabelTag className={`mb-2 font-display text-sm uppercase tracking-wide ${MUTED_TEXT_CLASS}`}>{group.label}</LabelTag>
          <div className={TABLE_WRAP_CLASS}>
            <table className={TABLE_CLASS}>
              <tbody>
                {group.rows.map((row, r) => (
                  <tr key={r} className={TABLE_ROW_CLASS}>
                    <td className={`py-2 pr-4 align-top font-mono text-sm whitespace-nowrap ${ACCENT_TEXT_CLASS}`}>
                      {row.term}
                    </td>
                    <td className={`py-2 align-top ${MUTED_TEXT_CLASS}`}>{row.description}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}

      {section.blocks.map((block, i) => (
        <div key={i} className="mb-4">
          <LabelTag className={`mb-2 font-display text-sm uppercase tracking-wide ${MUTED_TEXT_CLASS}`}>{block.label}</LabelTag>
          <pre className={PRE_CLASS}>
            <code>{block.body}</code>
          </pre>
        </div>
      ))}

      <details className="mt-4 rounded-lg border border-[var(--color-text)]/15">
        <summary className={`cursor-pointer px-4 py-2 text-sm ${MUTED_TEXT_CLASS}`}>
          Exact <code className="font-mono">{section.invocation}</code> output
        </summary>
        <pre className="overflow-x-auto border-t border-[var(--color-text)]/15 p-4 font-mono text-sm">
          <code>{section.raw}</code>
        </pre>
      </details>
    </section>
  );
}

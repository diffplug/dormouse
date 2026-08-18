/**
 * Renders the block tree produced by `website/scripts/docs-parser.js`.
 *
 * The parser guarantees the tree contains only the supported subset, and that
 * any `image` node came either from Markdown or from the narrow `<img>`
 * allowlist — so nothing here needs to sanitize, and no HTML string is ever
 * injected (`dangerouslySetInnerHTML` is deliberately absent).
 *
 * See docs/specs/website-docs.md -> /docs rendering contract.
 */
import type { ReactNode } from "react";

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "image"; src: string; alt?: string; width?: string; height?: string; title?: string }
  | { type: "link"; href: string; title?: string; children: InlineNode[] }
  | { type: "strong"; children: InlineNode[] }
  | { type: "em"; children: InlineNode[] };

export type BlockNode =
  | { type: "heading"; depth: number; id: string; text: string; children: InlineNode[] }
  | { type: "paragraph"; tight?: boolean; children: InlineNode[] }
  | { type: "code"; lang: string | null; value: string }
  | { type: "list"; ordered: boolean; items: { type: "listItem"; children: BlockNode[] }[] }
  | { type: "table"; align: (string | null)[]; header: InlineNode[][]; rows: InlineNode[][][] }
  | { type: "blockquote"; children: BlockNode[] }
  | { type: "thematicBreak" };

const LINK_CLASS = "text-[var(--color-caramel)] underline-offset-2 hover:underline";
const CODE_CLASS = "text-[0.9em] bg-[var(--color-text)]/15 px-1.5 py-0.5 rounded font-mono";

/** Same-origin links stay in the tab; anything else opens safely in a new one. */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href) && !href.startsWith("https://dormouse.sh");
}

function Inline({ nodes }: { nodes: InlineNode[] }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <span key={i}>{node.value}</span>;
      case "code":
        return <code key={i} className={CODE_CLASS}>{node.value}</code>;
      case "strong":
        return <strong key={i} className="font-semibold"><Inline nodes={node.children} /></strong>;
      case "em":
        return <em key={i} className="italic"><Inline nodes={node.children} /></em>;
      case "image":
        return (
          <img
            key={i}
            src={node.src}
            alt={node.alt ?? ""}
            title={node.title}
            width={node.width}
            height={node.height}
            // Inline icons keep their intrinsic size; standalone art is capped
            // to the column so nothing forces a horizontal scroll on mobile.
            className={node.width ? "inline-block align-text-bottom" : "block h-auto max-w-full rounded-lg my-6"}
            loading="lazy"
          />
        );
      case "link": {
        const external = isExternal(node.href);
        return (
          <a
            key={i}
            href={node.href}
            title={node.title}
            className={LINK_CLASS}
            {...(external ? { target: "_blank", rel: "noopener noreferrer" } : {})}
          >
            <Inline nodes={node.children} />
          </a>
        );
      }
      default:
        return null;
    }
  });
}

const HEADING_CLASS: Record<number, string> = {
  2: "font-display text-2xl mt-12 mb-4 scroll-mt-24",
  3: "font-display text-xl mt-8 mb-3 scroll-mt-24",
  4: "font-display text-lg mt-6 mb-2 scroll-mt-24",
  5: "font-display text-base mt-4 mb-2 scroll-mt-24",
  6: "font-display text-base mt-4 mb-2 scroll-mt-24",
};

function Block({ node }: { node: BlockNode }): ReactNode {
  switch (node.type) {
    case "heading": {
      const Tag = `h${Math.min(node.depth, 6)}` as "h2";
      return (
        <Tag id={node.id} className={HEADING_CLASS[node.depth] ?? HEADING_CLASS[6]}>
          <a href={`#${node.id}`} className="no-underline hover:underline underline-offset-4">
            <Inline nodes={node.children} />
          </a>
        </Tag>
      );
    }
    case "paragraph":
      return (
        <p className={node.tight ? "leading-relaxed" : "text-lg leading-relaxed opacity-80 mb-4"}>
          <Inline nodes={node.children} />
        </p>
      );
    case "code":
      return (
        <pre className="mb-4 overflow-x-auto rounded-lg border border-[var(--color-text)]/15 bg-[var(--color-text)]/[0.04] p-4">
          <code className="font-mono text-sm">{node.value}</code>
        </pre>
      );
    case "list": {
      const Tag = node.ordered ? "ol" : "ul";
      return (
        <Tag className={`mb-4 space-y-2 pl-6 text-lg opacity-80 ${node.ordered ? "list-decimal" : "list-disc"}`}>
          {node.items.map((item, i) => (
            <li key={i} className="leading-relaxed">
              <Blocks nodes={item.children} />
            </li>
          ))}
        </Tag>
      );
    }
    case "table":
      return (
        <div className="mb-6 overflow-x-auto">
          <table className="w-full border-collapse text-left">
            <thead>
              <tr className="border-b border-[var(--color-text)]/25">
                {node.header.map((cell, i) => (
                  <th key={i} className="py-2 pr-4 font-display font-normal whitespace-nowrap">
                    <Inline nodes={cell} />
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r} className="border-b border-[var(--color-text)]/10">
                  {row.map((cell, c) => (
                    <td key={c} className="py-2 pr-4 align-top opacity-80">
                      <Inline nodes={cell} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );
    case "blockquote":
      return (
        <blockquote className="mb-4 border-l-2 border-[var(--color-caramel)]/50 pl-4 opacity-80">
          <Blocks nodes={node.children} />
        </blockquote>
      );
    case "thematicBreak":
      return <hr className="my-10 border-[var(--color-text)]/15" />;
    default:
      return null;
  }
}

function Blocks({ nodes }: { nodes: BlockNode[] }): ReactNode {
  return nodes.map((node, i) => <Block key={i} node={node} />);
}

export default function MarkdownDocument({ blocks }: { blocks: BlockNode[] }) {
  return <div className="docs-body">{<Blocks nodes={blocks} />}</div>;
}

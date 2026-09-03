/**
 * Renders the block tree produced by `website/scripts/docs-parser.js`.
 *
 * The parser guarantees the tree contains only the supported subset, and that
 * any `image` node came either from Markdown or from the narrow `<img>`
 * allowlist — so nothing here needs to sanitize, and no HTML string is ever
 * injected (`dangerouslySetInnerHTML` is deliberately absent).
 *
 * See docs/specs/website-docs.md -> Markdown rendering contract.
 */
import { Fragment, type ReactNode } from "react";
import {
  CODE_CLASS,
  LINK_CLASS,
  PRE_CLASS,
  SCROLL_MT_CLASS,
  TABLE_CLASS,
  TABLE_ROW_CLASS,
  TABLE_WRAP_CLASS,
} from "./docs-tokens";

export type InlineNode =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "image"; src: string; alt?: string; width?: string; height?: string; title?: string; standalone?: boolean }
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

/**
 * Same-site links stay in the tab; anything else opens safely in a new one.
 *
 * A scheme is the whole test because same-site links reach here root-relative:
 * the generator localizes the absolute URLs the canonical sources are required
 * to use (`localizeSiteLinks` in website/scripts/generate-docs.js).
 *
 * Spelled out rather than importing `hasScheme` from the parser that owns the
 * policy: that module is Node-side build code, and pulling it in would ship the
 * whole Markdown parser to the browser to share one regex.
 */
function isExternal(href: string): boolean {
  return /^[a-z][a-z0-9+.-]*:/i.test(href);
}

/**
 * An inline code span, wrappable at the separators inside it.
 *
 * A path like `~/Library/LaunchAgents/sh.dormouse.server.plist` is one
 * unbreakable word to the line breaker, so on a phone it pushed the whole page
 * wider than the viewport — the article scrolled sideways, not just the token.
 *
 * `<wbr>` offers a break after each `/`, `.`, `-` and `_` rather than letting
 * the text break anywhere, so a path splits where a reader expects and not
 * mid-segment. It contributes nothing to `textContent`, so copying the span
 * still yields the original string. `CODE_CLASS` carries `break-words` as the
 * backstop for a token with no separators at all, such as a long hash.
 *
 * Pinned by `website/src/components/MarkdownDocument.test.tsx`.
 */
function CodeSpan({ value }: { value: string }) {
  const parts = value.split(/(?<=[/._-])/);
  return (
    <code className={CODE_CLASS}>
      {parts.map((part, i) => (
        <Fragment key={i}>
          {part}
          {i < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </code>
  );
}

function Inline({ nodes }: { nodes: InlineNode[] }): ReactNode {
  return nodes.map((node, i) => {
    switch (node.type) {
      case "text":
        return <Fragment key={i}>{node.value}</Fragment>;
      case "code":
        return <CodeSpan key={i} value={node.value} />;
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
            // Standalone art is capped to the column so nothing forces a
            // horizontal scroll on mobile; inline icons keep intrinsic size.
            className={node.standalone ? "block h-auto max-w-full rounded-lg my-6" : "inline-block align-text-bottom"}
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

const HEADING_BASE = `font-display ${SCROLL_MT_CLASS}`;
/** Size per depth; the shared base is applied alongside. */
const HEADING_TEXT: Record<number, string> = {
  1: "text-3xl",
  2: "text-2xl",
  3: "text-xl",
  4: "text-lg",
  5: "text-base",
  6: "text-base",
};
/** Flow spacing per depth, for a heading rendered inline in a document. A
 *  caller that supplies its own section spacing overrides it. */
const HEADING_FLOW: Record<number, string> = {
  1: "mt-12 mb-4",
  2: "mt-12 mb-4",
  3: "mt-8 mb-3",
  4: "mt-6 mb-2",
  5: "mt-4 mb-2",
  6: "mt-4 mb-2",
};

/**
 * A heading that links to itself.
 *
 * Every `h1`–`h6` inside a Markdown document comes through here, so the anchor
 * affordance and the `scroll-mt` that keeps a jumped-to heading clear of the
 * sticky header have one owner. `spacing` replaces the depth's flow margins
 * for a caller whose surrounding section already spaces it.
 */
export function AnchoredHeading({
  id,
  depth = 2,
  spacing,
  children,
}: {
  id: string;
  depth?: number;
  spacing?: string;
  children: ReactNode;
}) {
  const level = depth in HEADING_TEXT ? depth : 6;
  const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4" | "h5" | "h6";
  return (
    <Tag id={id} className={`${HEADING_BASE} ${HEADING_TEXT[level]} ${spacing ?? HEADING_FLOW[level]}`}>
      <a href={`#${id}`} className="no-underline hover:underline underline-offset-4">
        {children}
      </a>
    </Tag>
  );
}

function Block({ node }: { node: BlockNode }): ReactNode {
  switch (node.type) {
    case "heading":
      return (
        <AnchoredHeading id={node.id} depth={node.depth}>
          <Inline nodes={node.children} />
        </AnchoredHeading>
      );
    case "paragraph":
      return (
        <p className={node.tight ? "leading-relaxed" : "text-lg leading-relaxed opacity-80 mb-4"}>
          <Inline nodes={node.children} />
        </p>
      );
    case "code":
      return (
        <pre className={`${PRE_CLASS} mb-4`}>
          <code>{node.value}</code>
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
        <div className={`mb-6 ${TABLE_WRAP_CLASS}`}>
          <table className={TABLE_CLASS}>
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
                <tr key={r} className={TABLE_ROW_CLASS}>
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
        <blockquote className="mb-4 border-l-2 border-[var(--docs-accent)]/50 pl-4 opacity-80">
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

/**
 * Render a parsed document.
 *
 * `renderAfterHeading` lets a page splice its own content in after a heading
 * (the agent-skill page uses it for CLI reference links) without the page
 * having to slice the block list up and reassemble the document itself.
 */
export default function MarkdownDocument({
  blocks,
  renderAfterHeading,
}: {
  blocks: BlockNode[];
  renderAfterHeading?: (heading: Extract<BlockNode, { type: "heading" }>) => ReactNode;
}) {
  return (
    <>
      {blocks.map((node, i) => (
        <Fragment key={i}>
          <Block node={node} />
          {node.type === "heading" && renderAfterHeading?.(node)}
        </Fragment>
      ))}
    </>
  );
}

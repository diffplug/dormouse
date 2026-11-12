import type { MDXEditorProps } from '@mdxeditor/editor';

type Options = NonNullable<MDXEditorProps['toMarkdownOptions']>;

/** A heading's key, comparable between its source line and its parsed tree:
 * link destinations, inline markers, and escapes are dropped on both sides. */
const headingKey = (depth: number, text: string) =>
  `${depth}:${text.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[\\`*_~[\]]/g, '').replace(/\s+/g, ' ').trim()}`;

type Phrasing = { value?: string; alt?: string | null; children?: Phrasing[] };
const plainText = (node: Phrasing): string =>
  node.value ?? node.children?.map(plainText).join('') ?? node.alt ?? '';

/** Keep the document's inexpensive style choices without retaining a second
 * editable syntax tree. Ambiguous Markdown still uses the stock serializer. */
export function markdownFormat(markdown: string): Options {
  const prose = markdown.replace(/^(`{3,}|~{3,})[^]*?^\1[^\n]*$/gm, '');
  const count = (pattern: RegExp) => prose.match(pattern)?.length ?? 0;
  const bullets = (['-', '*', '+'] as const).map(b => [b, count(new RegExp(`^[ \\t]*\\${b}[ \\t]+\\S`, 'gm'))] as const);
  const bullet = bullets.reduce((best, next) => next[1] > best[1] ? next : best)[0];
  // Per-heading choices preserve mixed files too. Newly added/renamed headings
  // use the majority; ties retain the serializer's blank line.
  const headings = new Map<string, number>();
  let tight = 0, loose = 0;
  for (const match of prose.matchAll(/^ {0,3}(#{1,6})[ \t]+([^\n]+)\n(?=([^\n]*))/gm)) {
    const gap = match[3].trim() ? 0 : 1;
    // An ATX closing sequence is not part of the heading's text.
    headings.set(headingKey(match[1].length, match[2].replace(/(?:^|[ \t]+)#+[ \t]*$/, '')), gap);
    if (gap) loose++; else tight++;
  }
  return {
    bullet,
    rule: count(/^\*{3,}[ \t]*$/gm) > count(/^-{3,}[ \t]*$/gm) ? '*' : '-',
    // A literal `<` must not turn into JSX when source mode imports the saved
    // text again; a `>` cannot start JSX, so it stays literal. Only text nodes
    // use this entity escape.
    unsafe: [{ character: '<', inConstruct: 'phrasing' }],
    handlers: {
      text(node, _parent, state, info) {
        const safe = state.safe(node.value, { ...info, encode: ['<'] })
          .replace(/\\[^]|&#x3C;/g, (match, offset: number, value: string) => {
            if (match === '&#x3C;') return '&lt;';
            // MDXEditor's `==highlight==` syntax escapes every `=`. Only a pair
            // can open a highlight, and only a line-start `=` a setext heading.
            if (match !== '\\=') return match;
            const before = info.before + value.slice(0, offset);
            const next = value.slice(offset + 2) || info.after;
            return /(^|[\r\n])[ \t]*$/.test(before) || before.endsWith('=') || /^\\?=/.test(next) ? match : '=';
          });
        // Restore only simple, complete labels. Keep escapes inside link labels
        // and list items (task syntax).
        if (state.stack.some(kind => ['label', 'reference', 'listItem'].includes(kind))) return safe;
        return safe.replace(/\\(?:\\|\[(\^?[\w .-]+)\])/g, (escaped, label: string | undefined, offset: number) => {
          if (!label) return escaped; // A literal backslash is not an escape to remove.
          const after = safe.slice(offset + escaped.length) || info.after;
          // GitHub reads `[^label]` and `[^label]:` as a footnote and its note,
          // which the editor keeps as text.
          const hazard = label.startsWith('^') ? /^\s*[\[(\]]/ : /^\s*[\[(:\]]/;
          if (hazard.test(after) || safe[offset - 1] === '!') return escaped;
          return `[${label}]`;
        });
      },
    },
    join: [left => {
      if (left.type !== 'heading') return;
      return headings.get(headingKey(left.depth, plainText(left as Phrasing))) ?? (tight > loose ? 0 : 1);
    }],
  };
}

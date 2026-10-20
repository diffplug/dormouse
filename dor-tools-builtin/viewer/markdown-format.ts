import type { MDXEditorProps } from '@mdxeditor/editor';

type Options = NonNullable<MDXEditorProps['toMarkdownOptions']>;

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
    headings.set(`${match[1].length}:${match[2].trim()}`, gap);
    if (gap) loose++; else tight++;
  }
  let references = false;
  return {
    bullet,
    rule: count(/^\*{3,}[ \t]*$/gm) > count(/^-{3,}[ \t]*$/gm) ? '*' : '-',
    // A literal angle bracket must not turn into JSX when source mode imports
    // the saved text again. Only text nodes use these entity escapes.
    unsafe: [{ character: '<', inConstruct: 'phrasing' }, { character: '>', inConstruct: 'phrasing' }],
    handlers: {
      root(node, _parent, state, info) {
        references = hasDefinition(node);
        return state.containerFlow(node, info);
      },
      text(node, _parent, state, info) {
        const safe = state.safe(node.value, { ...info, encode: ['<', '>'] })
          .replace(/\\[^]|&#x3([CE]);/g, (match, hex: string | undefined) => hex ? (hex === 'C' ? '&lt;' : '&gt;') : match);
        // Restore only simple, complete labels. Keep escapes inside link labels,
        // list items (task syntax), and documents with reference definitions.
        if (references || state.stack.some(kind => ['label', 'reference', 'listItem'].includes(kind))) return safe;
        return safe.replace(/\\(?:\\|\[([\w .-]+)\])/g, (escaped, label: string | undefined, offset: number) => {
          if (!label) return escaped; // A literal backslash is not an escape to remove.
          const after = safe.slice(offset + escaped.length) || info.after;
          if (/^\s*[\[(:\]]/.test(after) || safe[offset - 1] === '!') return escaped;
          return `[${label}]`;
        });
      },
    },
    join: [left => {
      if (left.type !== 'heading') return;
      const text = left.children.map(child => 'value' in child ? child.value : '').join('');
      return headings.get(`${left.depth}:${text}`) ?? (tight > loose ? 0 : 1);
    }],
  };
}

function hasDefinition(node: { type: string; children?: { type: string }[] }): boolean {
  return node.type === 'definition' || !!node.children?.some(hasDefinition);
}

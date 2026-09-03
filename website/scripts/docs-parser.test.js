import { describe, it, expect } from 'vitest';
import {
  parseMarkdown,
  parseInline,
  createSlugger,
  slugify,
  inlineToText,
  IMG_ALLOWED_ATTRS,
  UnsupportedMarkdownError,
} from './docs-parser.js';

describe('slugger', () => {
  it('matches GitHub-style slugs', () => {
    expect(slugify('Alerts and TODOs')).toBe('alerts-and-todos');
    expect(slugify('Browsers for you and your agents')).toBe('browsers-for-you-and-your-agents');
    expect(slugify('`dor list` — find surfaces')).toBe('dor-list--find-surfaces');
  });

  it('dedupes repeated headings', () => {
    const slug = createSlugger();
    expect(slug('Usage')).toBe('usage');
    expect(slug('Usage')).toBe('usage-1');
    expect(slug('Usage')).toBe('usage-2');
  });
});

describe('inline', () => {
  it('parses code, links, and strong', () => {
    const nodes = parseInline('see `dor list` in the [docs](https://example.com) **now**');
    expect(nodes.map((n) => n.type)).toEqual(['text', 'code', 'text', 'link', 'text', 'strong']);
  });

  it('keeps a balanced paren inside a link destination', () => {
    const nodes = parseInline('see [Foo](https://x.test/wiki/Foo_(bar)) now');
    expect(nodes[1]).toMatchObject({ type: 'link', href: 'https://x.test/wiki/Foo_(bar)' });
    expect(nodes[2]).toMatchObject({ type: 'text', value: ' now' });
  });

  it('keeps a paren inside a link title out of the destination scan', () => {
    const nodes = parseInline('[a](/x "the (title)") end');
    expect(nodes[0]).toMatchObject({ type: 'link', href: '/x', title: 'the (title)' });
  });

  it('honours backslash escapes', () => {
    expect(inlineToText(parseInline('a \\| b'))).toBe('a | b');
  });

  it('does not treat snake_case as emphasis', () => {
    expect(inlineToText(parseInline('surface_id_value'))).toBe('surface_id_value');
  });

  it('preserves every allowlisted attribute on an https img', () => {
    // Keyed off the allowlist itself: allowing an attribute the parser then
    // drops on the way out fails here, where a fixed list of today's five
    // would keep passing. A new entry must gain a sample below.
    const sample = {
      src: 'https://x.test/a.png',
      alt: 'bell',
      width: '22',
      height: '22',
      title: 'Alert ringing',
    };
    expect(Object.keys(sample).sort()).toEqual([...IMG_ALLOWED_ATTRS].sort());

    const attrs = Object.entries(sample).map(([name, value]) => `${name}="${value}"`).join(' ');
    const [img] = parseInline(`<img ${attrs} />`);
    expect(img).toMatchObject({ type: 'image', ...sample });
  });

  it('rejects a disallowed img attribute', () => {
    expect(() => parseInline('<img src="https://x.test/a.png" onerror="alert(1)" />'))
      .toThrow(UnsupportedMarkdownError);
  });

  it('accepts a repo-relative img src', () => {
    const [img] = parseInline('<img width="22" height="22" alt="bell" src="media/alert-armed.gif" />');
    expect(img).toMatchObject({ type: 'image', src: 'media/alert-armed.gif' });
  });

  it('rejects a non-https absolute img src', () => {
    expect(() => parseInline('<img src="http://x.test/a.png" />')).toThrow(/relative or https/);
    expect(() => parseInline('<img src="data:image/gif;base64,AA" />')).toThrow(/relative or https/);
  });

  it('rejects every other raw HTML tag', () => {
    expect(() => parseInline('a <script>x</script> b')).toThrow(/raw HTML <script>/);
    expect(() => parseInline('line<br>break')).toThrow(/raw HTML <br>/);
  });
});

describe('blocks', () => {
  it('parses headings with ids', () => {
    const { blocks, headings } = parseMarkdown('# One\n\n## Two Words\n');
    expect(blocks[0]).toMatchObject({ type: 'heading', depth: 1, id: 'one' });
    expect(headings).toEqual([
      { depth: 1, id: 'one', text: 'One' },
      { depth: 2, id: 'two-words', text: 'Two Words' },
    ]);
  });

  it('parses fenced code and keeps it verbatim', () => {
    const { blocks } = parseMarkdown('```sh\ndor list\n  indented\n```\n');
    expect(blocks[0]).toEqual({ type: 'code', lang: 'sh', value: 'dor list\n  indented' });
  });

  it('throws on an unterminated fence', () => {
    expect(() => parseMarkdown('```\nnope\n')).toThrow(/unterminated fenced code/);
  });

  it('keeps a shorter fence inside a longer one as code, not prose', () => {
    const md = '````markdown\n```bash\necho hi\n```\n````\n';
    const { blocks } = parseMarkdown(md);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toEqual({ type: 'code', lang: 'markdown', value: '```bash\necho hi\n```' });
  });

  it('rejects a setext underline instead of shipping it as text', () => {
    expect(() => parseMarkdown('Title\n=====\n')).toThrow(UnsupportedMarkdownError);
    expect(() => parseMarkdown('Title\n-----\n')).toThrow(/setext heading underline/);
  });

  it('ends a blockquote at a line that starts a new block', () => {
    const { blocks } = parseMarkdown('> quoted\n# Heading\n');
    expect(blocks.map((b) => b.type)).toEqual(['blockquote', 'heading']);
    expect(blocks[1].id).toBe('heading');
  });

  it('still folds a lazy continuation line into the blockquote', () => {
    const { blocks } = parseMarkdown('> quoted\ncontinues\n');
    expect(blocks).toHaveLength(1);
    expect(inlineToText(blocks[0].children[0].children)).toBe('quoted continues');
  });

  it('breaks a paragraph at a thematic break instead of eating it as emphasis', () => {
    const { blocks } = parseMarkdown('Some text\n***\nNext\n');
    expect(blocks.map((b) => b.type)).toEqual(['paragraph', 'thematicBreak', 'paragraph']);
    expect(inlineToText(blocks[0].children)).toBe('Some text');
    expect(inlineToText(blocks[2].children)).toBe('Next');
  });

  it('still reads a dashed underline as a setext heading, not a thematic break', () => {
    expect(() => parseMarkdown('Title\n---\n')).toThrow(/setext heading underline/);
  });

  it('ends a blockquote at a thematic break rather than raising a setext error', () => {
    const { blocks } = parseMarkdown('> quoted\n---\n');
    expect(blocks.map((b) => b.type)).toEqual(['blockquote', 'thematicBreak']);
  });

  it('ends a blockquote at a table rather than swallowing its rows', () => {
    const { blocks } = parseMarkdown('> quoted\n| a | b |\n|---|---|\n| 1 | 2 |\n');
    expect(blocks.map((b) => b.type)).toEqual(['blockquote', 'table']);
    expect(blocks[1].header.map(inlineToText)).toEqual(['a', 'b']);
  });

  it('ends a blockquote at block-level raw HTML, which then raises', () => {
    expect(() => parseMarkdown('> quoted\n<div>\n')).toThrow(/raw HTML <div>/);
  });

  it('keeps a standalone <img> line inside the paragraph it follows', () => {
    const { blocks } = parseMarkdown('text\n<img src="a.png" alt="a">\n');
    expect(blocks).toHaveLength(1);
    expect(blocks[0].children.map((n) => n.type)).toEqual(['text', 'image']);
  });

  it('rejects a setext underline inside a list item too', () => {
    expect(() => parseMarkdown('- item\n  Title\n  =====\n')).toThrow(/setext heading underline/);
  });

  it('ends a list item at a thematic break in its continuation', () => {
    const { blocks } = parseMarkdown('- item\n  ***\n');
    expect(blocks.map((b) => b.type)).toEqual(['list', 'thematicBreak']);
  });

  it('reads a pipeless dashed underline as a setext heading, not a table delimiter row', () => {
    expect(() => parseMarkdown('Intro\na | b\n---\n')).toThrow(/setext heading underline/);
    expect(() => parseMarkdown('a | b\n---\n')).toThrow(/setext heading underline/);
  });

  it('reads a delimiter row whose cell count differs from the header as prose', () => {
    expect(parseMarkdown('Intro\na | b\n| --- |\n').blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(parseMarkdown('a | b\n| --- |\n').blocks.map((b) => b.type)).toEqual(['paragraph']);
    expect(parseMarkdown('a | b | c\n--- | ---\n1 | 2 | 3\n').blocks.map((b) => b.type)).toEqual(['paragraph']);
  });

  it('keeps a mismatched delimiter row inside the blockquote it lazily continues', () => {
    const { blocks } = parseMarkdown('> quoted\na | b\n| --- |\n');
    expect(blocks.map((b) => b.type)).toEqual(['blockquote']);
  });

  it('still parses a table whose header omits the outer pipes', () => {
    const { blocks } = parseMarkdown('a|b\n-|-\n1|2\n');
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].header.map(inlineToText)).toEqual(['a', 'b']);
    expect(blocks[0].rows[0].map(inlineToText)).toEqual(['1', '2']);
  });

  it('counts an escaped pipe in the header as one cell, not two', () => {
    const { blocks } = parseMarkdown('a \\| b | c\n--- | ---\n1 | 2\n');
    expect(blocks[0].type).toBe('table');
    expect(blocks[0].header.map(inlineToText)).toEqual(['a | b', 'c']);
  });

  it('parses a table with an escaped pipe inside inline code', () => {
    const md = '| Key | Action |\n|-----|--------|\n| `\\|` or tmux `%` | Split |\n';
    const { blocks } = parseMarkdown(md);
    expect(blocks[0].type).toBe('table');
    expect(inlineToText(blocks[0].rows[0][0])).toBe('| or tmux %');
    expect(inlineToText(blocks[0].rows[0][1])).toBe('Split');
  });

  it('parses nested lists', () => {
    const { blocks } = parseMarkdown('- one\n- two\n  - nested\n');
    expect(blocks[0].type).toBe('list');
    expect(blocks[0].items).toHaveLength(2);
    const nested = blocks[0].items[1].children.find((c) => c.type === 'list');
    expect(inlineToText(nested.items[0].children[0].children)).toBe('nested');
  });

  it('parses ordered lists', () => {
    const { blocks } = parseMarkdown('1. first\n2. second\n');
    expect(blocks[0]).toMatchObject({ type: 'list', ordered: true });
    expect(blocks[0].items).toHaveLength(2);
  });

  it('keeps a list item with an inline img', () => {
    const md = '- <img width="22" height="22" alt="b" src="https://x.test/b.png" /> ringing\n';
    const { blocks } = parseMarkdown(md);
    const kids = blocks[0].items[0].children[0].children;
    expect(kids[0]).toMatchObject({ type: 'image', width: '22' });
    expect(inlineToText(kids).trim()).toBe('b ringing');
  });

  it('parses blockquotes', () => {
    const { blocks } = parseMarkdown('> quoted line\n');
    expect(blocks[0].type).toBe('blockquote');
    expect(blocks[0].children[0].type).toBe('paragraph');
  });

  it('rejects block-level raw HTML that is not img', () => {
    expect(() => parseMarkdown('<div>hi</div>\n')).toThrow(/raw HTML <div>/);
  });
});

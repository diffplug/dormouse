import { describe, it, expect } from 'vitest';
import {
  parseMarkdown,
  parseInline,
  createSlugger,
  slugify,
  inlineToText,
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

  it('honours backslash escapes', () => {
    expect(inlineToText(parseInline('a \\| b'))).toBe('a | b');
  });

  it('does not treat snake_case as emphasis', () => {
    expect(inlineToText(parseInline('surface_id_value'))).toBe('surface_id_value');
  });

  it('accepts an allowlisted https img', () => {
    const [img] = parseInline('<img width="22" height="22" alt="bell" src="https://x.test/a.png" />');
    expect(img).toMatchObject({ type: 'image', width: '22', height: '22', src: 'https://x.test/a.png' });
  });

  it('rejects a disallowed img attribute', () => {
    expect(() => parseInline('<img src="https://x.test/a.png" onerror="alert(1)" />'))
      .toThrow(UnsupportedMarkdownError);
  });

  it('rejects a non-https img src', () => {
    expect(() => parseInline('<img src="http://x.test/a.png" />')).toThrow(/must be https/);
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

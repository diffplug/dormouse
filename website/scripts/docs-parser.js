/**
 * Hand-rolled Markdown parser for the public docs pipeline.
 *
 * Deliberately supports a *subset* of CommonMark rather than pretending to be
 * complete. A third-party parser degrades gracefully on constructs it does not
 * know; a hand-rolled one silently mangles them. So anything outside the subset
 * is a hard error (`UnsupportedMarkdownError`), and the public-doc lint turns
 * that into a build failure instead of a rendering bug nobody notices.
 *
 * Raw HTML is rejected with one exception: a narrow `<img>` allowlist, because
 * the canonical README uses inline 22px alert-state icons and portable Markdown
 * has no image-sizing syntax (docs/specs/website-docs.md -> /docs rendering
 * contract).
 *
 * No dependencies, by design. Runs in Node during codegen and its output is
 * plain JSON consumed by the website.
 */

export class UnsupportedMarkdownError extends Error {
  constructor(message, line) {
    super(line == null ? message : `${message} (line ${line})`);
    this.name = 'UnsupportedMarkdownError';
    this.line = line;
  }
}

/** Attributes an `<img>` may carry. Everything else is rejected. */
export const IMG_ALLOWED_ATTRS = new Set(['src', 'alt', 'width', 'height', 'title']);

// ---------------------------------------------------------------------------
// Slugger — mirrors github-slugger so /docs anchors match GitHub's own.
// ---------------------------------------------------------------------------

/**
 * Whether a URL carries a scheme (`https:`, `mailto:`, `vscode:`).
 *
 * The parser owns this because it owns the `<img>` URL policy, and four
 * decisions turn on the same question: rejecting a raw `<img src>`, rejecting a
 * guide image, deciding whether a link leaves the site, and deciding whether a
 * link is local enough to resolve on disk. Spelled once so those four cannot
 * disagree about what a scheme looks like.
 */
export function hasScheme(url) {
  return /^[a-z][a-z0-9+.-]*:/i.test(url);
}

/** `//host/path` — no scheme, but not local either. */
export function isProtocolRelative(url) {
  return url.startsWith('//');
}

export function slugify(text) {
  return text
    .trim()
    .toLowerCase()
    // Strip everything that is not alphanumeric, space, hyphen, or underscore.
    // \p{L}/\p{N} keep non-ASCII headings usable.
    .replace(/[^\p{L}\p{N} _-]+/gu, '')
    // github-slugger replaces each space individually rather than collapsing
    // runs, so "`dor list` - find" (em dash stripped from between two spaces)
    // becomes "dor-list--find". Matching that exactly is what keeps /docs
    // anchors identical to GitHub's for the same heading.
    .replace(/ /g, '-');
}

export function createSlugger() {
  const seen = new Map();
  return (text) => {
    const base = slugify(text) || 'section';
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    return n === 0 ? base : `${base}-${n}`;
  };
}

// ---------------------------------------------------------------------------
// Inline parsing
// ---------------------------------------------------------------------------

function parseImgTag(raw, line) {
  const inner = raw.replace(/^<img\s*/i, '').replace(/\/?>$/, '');
  const attrs = {};
  const re = /([a-zA-Z][a-zA-Z0-9-]*)\s*=\s*"([^"]*)"/g;
  let m;
  while ((m = re.exec(inner))) {
    const [, name, value] = m;
    const key = name.toLowerCase();
    if (!IMG_ALLOWED_ATTRS.has(key)) {
      throw new UnsupportedMarkdownError(`<img> attribute "${name}" is not allowed`, line);
    }
    attrs[key] = value;
  }
  // Anything left over means unquoted or malformed attributes we did not parse.
  const leftover = inner.replace(re, '').trim();
  if (leftover.length > 0) {
    throw new UnsupportedMarkdownError(`could not parse <img> attributes: "${leftover}"`, line);
  }
  if (!attrs.src) throw new UnsupportedMarkdownError('<img> requires a src', line);
  // A source is either a repo-relative local file (the authoring default, so
  // GitHub renders it natively) or an absolute https URL. Anything else --
  // http, protocol-relative, data: -- is rejected here; the public-doc lint
  // additionally requires relative files to exist and bans third-party hosts.
  if (hasScheme(attrs.src) && !/^https:\/\//i.test(attrs.src)) {
    throw new UnsupportedMarkdownError(`<img> src must be relative or https: "${attrs.src}"`, line);
  }
  return {
    type: 'image',
    src: attrs.src,
    alt: attrs.alt ?? '',
    width: attrs.width,
    height: attrs.height,
    title: attrs.title,
  };
}

/**
 * Parse inline content into a flat-ish node list. Emphasis may nest one level
 * inside link text; anything deeper is not needed by our sources.
 */
export function parseInline(text, line) {
  const nodes = [];
  let buf = '';
  let i = 0;

  const flush = () => {
    if (buf) {
      nodes.push({ type: 'text', value: buf });
      buf = '';
    }
  };

  while (i < text.length) {
    const ch = text[i];

    // Backslash escape
    if (ch === '\\' && i + 1 < text.length) {
      buf += text[i + 1];
      i += 2;
      continue;
    }

    // Inline code — longest matching backtick run
    if (ch === '`') {
      let ticks = 0;
      while (text[i + ticks] === '`') ticks++;
      const fence = '`'.repeat(ticks);
      const end = text.indexOf(fence, i + ticks);
      if (end !== -1) {
        flush();
        nodes.push({ type: 'code', value: text.slice(i + ticks, end) });
        i = end + ticks;
        continue;
      }
      buf += ch;
      i++;
      continue;
    }

    // Allowlisted inline <img>
    if (text.startsWith('<img', i)) {
      const end = text.indexOf('>', i);
      if (end === -1) throw new UnsupportedMarkdownError('unterminated <img> tag', line);
      flush();
      nodes.push(parseImgTag(text.slice(i, end + 1), line));
      i = end + 1;
      continue;
    }

    // Any other raw HTML is rejected outright.
    if (ch === '<' && /^<\/?[a-zA-Z]/.test(text.slice(i))) {
      const tag = /^<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(text.slice(i));
      throw new UnsupportedMarkdownError(`raw HTML <${tag ? tag[1] : '?'}> is not allowed`, line);
    }

    // Image / link
    if (ch === '!' && text[i + 1] === '[') {
      const parsed = matchLink(text, i + 1);
      if (parsed) {
        flush();
        nodes.push({ type: 'image', src: parsed.href, alt: parsed.label, title: parsed.title });
        i = parsed.end;
        continue;
      }
    }
    if (ch === '[') {
      const parsed = matchLink(text, i);
      if (parsed) {
        flush();
        nodes.push({ type: 'link', href: parsed.href, title: parsed.title, children: parseInline(parsed.label, line) });
        i = parsed.end;
        continue;
      }
    }

    // Strong / emphasis
    if (ch === '*' || ch === '_') {
      const strong = ch + ch;
      if (text.startsWith(strong, i)) {
        const end = text.indexOf(strong, i + 2);
        if (end !== -1) {
          flush();
          nodes.push({ type: 'strong', children: parseInline(text.slice(i + 2, end), line) });
          i = end + 2;
          continue;
        }
      }
      const end = text.indexOf(ch, i + 1);
      // Avoid treating snake_case as emphasis.
      if (end !== -1 && !(ch === '_' && /\w/.test(text[i - 1] ?? ''))) {
        flush();
        nodes.push({ type: 'em', children: parseInline(text.slice(i + 1, end), line) });
        i = end + 1;
        continue;
      }
    }

    buf += ch;
    i++;
  }

  flush();
  return nodes;
}

/**
 * The index of the `)` that closes the destination opened at `open`, or -1.
 *
 * Parentheses nest rather than closing at the first `)`, because a URL is
 * allowed to contain a balanced pair and several the docs link to do
 * (`.../wiki/Foo_(bar)`). Stopping at the first one truncates the href and
 * still emits a link, so the page ships a live anchor pointing somewhere else
 * — exactly the silent mangling this parser exists to avoid. A `"` toggles a
 * title span, where a paren is literal.
 */
function matchDestination(text, open) {
  let depth = 1;
  let inTitle = false;
  for (let i = open + 1; i < text.length; i++) {
    const ch = text[i];
    if (ch === '\\') { i++; continue; }
    if (ch === '"') { inTitle = !inTitle; continue; }
    if (inTitle) continue;
    if (ch === '(') depth++;
    else if (ch === ')') {
      depth--;
      if (depth === 0) return i;
    }
  }
  return -1;
}

/** Match `[label](href "title")` starting at `start`. Returns null if not one. */
function matchLink(text, start) {
  if (text[start] !== '[') return null;
  let depth = 0;
  let i = start;
  for (; i < text.length; i++) {
    if (text[i] === '\\') { i++; continue; }
    if (text[i] === '[') depth++;
    else if (text[i] === ']') {
      depth--;
      if (depth === 0) break;
    }
  }
  if (depth !== 0 || text[i + 1] !== '(') return null;
  const label = text.slice(start + 1, i);
  const close = matchDestination(text, i + 1);
  if (close === -1) return null;
  const target = text.slice(i + 2, close).trim();
  const titleMatch = /^(\S+)\s+"([^"]*)"$/.exec(target);
  return titleMatch
    ? { label, href: titleMatch[1], title: titleMatch[2], end: close + 1 }
    : { label, href: target, title: undefined, end: close + 1 };
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

const LIST_ITEM = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

/**
 * Whether `line` closes a fence opened with `length` copies of `marker`.
 *
 * The closing run must be at least as long as the opening one. Without that
 * length test a ````-fenced block closes at the first ``` inside it — the very
 * form AGENTS.md prescribes for nesting one code block inside another — so the
 * block's body spills out and renders as prose, with no error to notice.
 */
function closesFence(line, marker, length) {
  const trimmed = line.trim();
  return trimmed.length >= length && [...trimmed].every((ch) => ch === marker);
}

/**
 * Whether `line` begins a new block, so a paragraph — or a blockquote's lazy
 * continuation — ends before it instead of swallowing it. `next` supplies the
 * single line of lookahead a table needs; `startsTable` holds the test.
 *
 * Six of the seven block starts are here: ATX heading, list item, blockquote,
 * fence, table, and block-level raw HTML. A standalone `<img>` is deliberately
 * absent — it is inline-level, so GitHub keeps it in the paragraph and so do
 * we. The seventh, the thematic break, is tested separately at each call site
 * because `---` is also a setext underline, which has to raise first.
 */
function interruptsParagraph(line, next) {
  return /^(#{1,6})\s+/.test(line)
    || LIST_ITEM.test(line)
    || /^\s*>\s?/.test(line)
    || /^(\s*)(`{3,}|~{3,})/.test(line)
    || startsTable(line, next ?? '')
    || (/^\s*<\/?[a-zA-Z]/.test(line) && !/^\s*<img\b/i.test(line));
}

/**
 * A setext underline (`===` / `---` under a line of text). GitHub renders one
 * as a heading; this parser has no block for it, so left alone the underline
 * joins the paragraph and ships as the literal text `Title ===`. Rejected
 * rather than supported: `#` is the only heading form the sources use, and an
 * error names the line instead of leaving a reader to spot the difference.
 */
const SETEXT_UNDERLINE = /^\s*(=+|-+)\s*$/;

/**
 * A thematic break (`***`, `___`, `- - -`). CommonMark lets one interrupt a
 * paragraph, so without this the line joins the paragraph and `parseInline`
 * eats the run as an empty emphasis span — `***` ships as a dropped rule and
 * two lost characters. Checked after `SETEXT_UNDERLINE`, never before: `---`
 * matches both, and GitHub reads it as a setext heading.
 */
const THEMATIC_BREAK = /^\s*([-*_])(\s*\1){2,}\s*$/;

/**
 * Split a table row into raw cell strings, honouring backslash-escaped pipes so
 * a cell containing `` `\|` `` (which the shortcut table needs) survives intact.
 *
 * Kept separate from `splitRow` because `startsTable` counts cells
 * speculatively on every paragraph line, where `parseInline` would raise on
 * inline content the parser rejects.
 */
function splitCells(row) {
  const trimmed = row.trim().replace(/^\|/, '').replace(/\|$/, '');
  const cells = [];
  let cur = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (ch === '\\' && trimmed[i + 1] === '|') { cur += '|'; i++; continue; }
    if (ch === '\\') { cur += ch + (trimmed[i + 1] ?? ''); i++; continue; }
    if (ch === '|') { cells.push(cur); cur = ''; continue; }
    cur += ch;
  }
  cells.push(cur);
  return cells;
}

/** Split a table row into cells and parse each one's inline content. */
function splitRow(row, line) {
  return splitCells(row).map((c) => parseInline(c.trim(), line));
}

/**
 * A GFM delimiter row (`| --- | :-- |`). The pipe is required: every `|` in the
 * pattern is optional, so without this test a bare `---` reads as a one-column
 * delimiter row and a preceding line that merely contains a pipe becomes a
 * table — where the `---` is a setext underline, which has to raise instead.
 */
function isDelimiterRow(row) {
  return row.includes('|') && /^\s*\|?\s*:?-{1,}:?\s*(\|\s*:?-{1,}:?\s*)*\|?\s*$/.test(row);
}

/**
 * Whether `line` and the delimiter row `next` start a GFM table. The cell
 * counts have to match: GFM does not recognise a table when they differ, so
 * `a | b` over `| --- |` is paragraph text, and reading it as a table drops the
 * delimiter row and restyles the prose with no error.
 */
function startsTable(line, next) {
  return line.includes('|')
    && isDelimiterRow(next)
    && splitCells(line).length === splitCells(next).length;
}

function alignmentsFrom(row) {
  return row.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => {
    const s = c.trim();
    if (s.startsWith(':') && s.endsWith(':')) return 'center';
    if (s.endsWith(':')) return 'right';
    if (s.startsWith(':')) return 'left';
    return null;
  });
}

/**
 * Parse Markdown into a block node tree.
 *
 * @param {string} markdown
 * @param {{ slug?: (text: string) => string }} [options]
 */
export function parseMarkdown(markdown, options = {}) {
  const slug = options.slug ?? createSlugger();
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const blocks = [];
  const headings = [];
  let i = 0;

  while (i < lines.length) {
    const raw = lines[i];
    const lineNo = i + 1;

    if (raw.trim() === '') { i++; continue; }

    // Fenced code
    const fence = /^(\s*)(`{3,}|~{3,})\s*([\w+-]*)\s*$/.exec(raw);
    if (fence) {
      const marker = fence[2][0];
      const openLength = fence[2].length;
      const lang = fence[3] || null;
      const body = [];
      i++;
      let closed = false;
      while (i < lines.length) {
        if (closesFence(lines[i], marker, openLength)) { closed = true; i++; break; }
        body.push(lines[i]);
        i++;
      }
      if (!closed) throw new UnsupportedMarkdownError('unterminated fenced code block', lineNo);
      blocks.push({ type: 'code', lang, value: body.join('\n') });
      continue;
    }

    // ATX heading
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(raw);
    if (heading) {
      const depth = heading[1].length;
      const children = parseInline(heading[2], lineNo);
      const text = inlineToText(children);
      const id = slug(text);
      blocks.push({ type: 'heading', depth, id, text, children });
      headings.push({ depth, id, text });
      i++;
      continue;
    }

    // Thematic break
    if (THEMATIC_BREAK.test(raw)) {
      blocks.push({ type: 'thematicBreak' });
      i++;
      continue;
    }

    // Table
    if (i + 1 < lines.length && startsTable(raw, lines[i + 1])) {
      const header = splitRow(raw, lineNo);
      const align = alignmentsFrom(lines[i + 1]);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].trim() !== '' && lines[i].includes('|')) {
        rows.push(splitRow(lines[i], i + 1));
        i++;
      }
      blocks.push({ type: 'table', align, header, rows });
      continue;
    }

    // Blockquote
    if (/^\s*>\s?/.test(raw)) {
      const body = [];
      while (
        i < lines.length
        && (/^\s*>\s?/.test(lines[i])
          || (lines[i].trim() !== '' && body.length > 0
            && !interruptsParagraph(lines[i], lines[i + 1])
            && !THEMATIC_BREAK.test(lines[i])))
      ) {
        body.push(lines[i].replace(/^\s*>\s?/, ''));
        i++;
      }
      blocks.push({ type: 'blockquote', children: parseMarkdown(body.join('\n'), { slug }).blocks });
      continue;
    }

    // Lists
    if (LIST_ITEM.test(raw)) {
      const { node, next } = parseList(lines, i, slug);
      blocks.push(node);
      i = next;
      continue;
    }

    // Standalone <img> block
    if (/^\s*<img\b/i.test(raw)) {
      blocks.push({ type: 'paragraph', children: markStandalone(parseInline(raw.trim(), lineNo)) });
      i++;
      continue;
    }

    // Any other block-level raw HTML is rejected.
    if (/^\s*<\/?[a-zA-Z]/.test(raw)) {
      const tag = /^\s*<\/?([a-zA-Z][a-zA-Z0-9-]*)/.exec(raw);
      throw new UnsupportedMarkdownError(`raw HTML <${tag ? tag[1] : '?'}> is not allowed`, lineNo);
    }

    // Paragraph — consume until blank line or a line that starts a new block.
    const para = [];
    while (i < lines.length && lines[i].trim() !== '') {
      const l = lines[i];
      if (para.length > 0 && interruptsParagraph(l, lines[i + 1])) break;
      if (para.length > 0 && SETEXT_UNDERLINE.test(l)) {
        throw new UnsupportedMarkdownError('setext heading underline — use an ATX `#` heading', i + 1);
      }
      if (para.length > 0 && THEMATIC_BREAK.test(l)) break;
      para.push(l.trim());
      i++;
    }
    blocks.push({ type: 'paragraph', children: markStandalone(parseInline(para.join(' '), lineNo)) });
  }

  return { blocks, headings };
}

/**
 * Tag an image that is the whole paragraph as standalone art.
 *
 * The distinction between page art and an inline icon is known here and
 * nowhere else; without it a renderer has to guess from something incidental
 * like the presence of a width attribute, which then silently reclassifies any
 * image that gains one.
 */
function markStandalone(children) {
  const visible = children.filter((n) => !(n.type === 'text' && n.value.trim() === ''));
  if (visible.length === 1 && visible[0].type === 'image') visible[0].standalone = true;
  return children;
}

function parseList(lines, start, slug) {
  const first = LIST_ITEM.exec(lines[start]);
  const baseIndent = first[1].length;
  const ordered = /\d/.test(first[2]);
  const items = [];
  let i = start;

  while (i < lines.length) {
    const m = LIST_ITEM.exec(lines[i]);
    if (!m) {
      // A blank line inside a list is allowed if a further item follows.
      if (lines[i].trim() === '' && LIST_ITEM.test(lines[i + 1] ?? '')) { i++; continue; }
      break;
    }
    const indent = m[1].length;
    if (indent < baseIndent) break;
    if (indent > baseIndent) {
      const { node, next } = parseList(lines, i, slug);
      if (items.length === 0) throw new UnsupportedMarkdownError('nested list without a parent item', i + 1);
      items[items.length - 1].children.push(node);
      i = next;
      continue;
    }
    const contentLines = [m[3]];
    i++;
    // Continuation lines: indented further, not themselves list items.
    while (i < lines.length && lines[i].trim() !== '' && !LIST_ITEM.test(lines[i]) && /^\s+/.test(lines[i])) {
      // The same two guards a paragraph applies, so `Headings are ATX only`
      // holds inside a list item too rather than shipping as literal text.
      if (SETEXT_UNDERLINE.test(lines[i])) {
        throw new UnsupportedMarkdownError('setext heading underline — use an ATX `#` heading', i + 1);
      }
      if (THEMATIC_BREAK.test(lines[i])) break;
      contentLines.push(lines[i].trim());
      i++;
    }
    items.push({ type: 'listItem', children: [{ type: 'paragraph', tight: true, children: parseInline(contentLines.join(' '), i) }] });
  }

  return { node: { type: 'list', ordered, items }, next: i };
}

/**
 * Visit every node in a parsed tree, blocks and inlines alike.
 *
 * Every value is descended into, rather than a named list of container keys:
 * such a list is a mirror of the node schema, and it drifts the moment a node
 * type gains a child array. (The first such mirror missed table body cells
 * entirely, since a row is an array of cell arrays rather than a node.) The
 * guard below discards strings, numbers, and nulls, so `align: ['left', null]`
 * and every `value`/`raw` string costs nothing.
 *
 * Accepts a node, an array, or an arbitrarily nested array of either.
 */
export function visit(tree, fn) {
  if (Array.isArray(tree)) {
    for (const entry of tree) visit(entry, fn);
    return;
  }
  if (!tree || typeof tree !== 'object') return;
  fn(tree);
  for (const value of Object.values(tree)) visit(value, fn);
}

export function inlineToText(nodes) {
  return nodes
    .map((n) => {
      switch (n.type) {
        case 'text': return n.value;
        case 'code': return n.value;
        case 'image': return n.alt ?? '';
        case 'link':
        case 'strong':
        case 'em': return inlineToText(n.children);
        default: return '';
      }
    })
    .join('');
}

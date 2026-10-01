// Prototype model for the copy editor mockups (Prototypes/Copy editor). Pure
// functions over a mock screen: nothing here is wired to xterm or the real
// selection store. The real feature would read the same facts from the xterm
// buffer (row text, `isWrapped`, cell attributes) and the foreground program.

export type Tone = 'muted' | 'link' | 'code' | 'accent' | 'user' | 'frame' | 'prompt' | 'pass';

export interface ToneSpan { from: number; to: number; tone: Tone }

export interface MockRow {
  text: string;
  /** xterm's `isWrapped`: a true soft wrap continuing the previous row. */
  wrapped?: boolean;
  /** An OSC 133 prompt row: a paragraph never grows across it. */
  prompt?: boolean;
  tones?: ToneSpan[];
}

export interface MockBlock { from: number; to: number; label: string }

export interface MockScreen {
  id: 'claude' | 'shell';
  title: string;
  program: string;
  cols: number;
  /** The column a hard-wrapping program wraps at. Present only for programs
   *  known to hard-wrap (a real build would key this off the foreground
   *  command); absent means only `wrapped` rows are wraps. */
  hardWrapWidth?: number;
  rows: MockRow[];
  /** The widest expansion: a TUI message, or an OSC 133 command output. */
  blocks: MockBlock[];
}

// ---------------------------------------------------------------------------
// Mock screens

interface WrapTone { from: number; to: number; tone: Tone }

/** Greedy word wrap with a hard break for tokens wider than the line, the way
 *  Ink-based TUIs render prose. Tones are ranges over the logical text. */
function wrapParagraph(text: string, width: number, first: string, cont: string, tones: WrapTone[] = [], prefixTone?: Tone): MockRow[] {
  type Cell = { ch: string; i: number };
  const rows: Cell[][] = [];
  let cur: Cell[] = [...first].map((ch) => ({ ch, i: -1 }));
  let hasContent = false;
  const flush = () => {
    rows.push(cur);
    cur = [...cont].map((ch) => ({ ch, i: -1 }));
    hasContent = false;
  };
  const words: { w: string; at: number }[] = [];
  for (const m of text.matchAll(/\S+/g)) words.push({ w: m[0], at: m.index ?? 0 });
  for (const { w, at } of words) {
    const need = (hasContent ? 1 : 0) + w.length;
    if (cur.length + need <= width) {
      if (hasContent) cur.push({ ch: ' ', i: at - 1 });
      for (let k = 0; k < w.length; k++) cur.push({ ch: w[k], i: at + k });
      hasContent = true;
    } else if (w.length <= width - cont.length) {
      flush();
      for (let k = 0; k < w.length; k++) cur.push({ ch: w[k], i: at + k });
      hasContent = true;
    } else {
      if (hasContent) cur.push({ ch: ' ', i: at - 1 });
      for (let k = 0; k < w.length; k++) {
        if (cur.length >= width) flush();
        cur.push({ ch: w[k], i: at + k });
      }
      hasContent = true;
    }
  }
  rows.push(cur);
  return rows.map((cells) => {
    const spans: ToneSpan[] = [];
    cells.forEach((cell, col) => {
      const tone = cell.i < 0 ? (cell.ch === ' ' ? undefined : prefixTone) : tones.find((t) => cell.i >= t.from && cell.i < t.to)?.tone;
      if (!tone) return;
      const last = spans[spans.length - 1];
      if (last && last.tone === tone && last.to === col) last.to = col + 1;
      else spans.push({ from: col, to: col + 1, tone });
    });
    return { text: cells.map((c) => c.ch).join(''), tones: spans };
  });
}

function toned(text: string, tone: Tone): MockRow {
  return { text, tones: [{ from: 0, to: text.length, tone }] };
}

function range(text: string, needle: string, tone: Tone): WrapTone {
  const from = text.indexOf(needle);
  return { from, to: from + needle.length, tone };
}

function buildClaudeScreen(): MockScreen {
  const cols = 80;
  const W = 76;
  const blank: MockRow = { text: '' };
  const prose = 'The flake comes from a race between the PTY exit event and the final flush of the output buffer. When the child exits before xterm has drained its write queue, the last chunk is dropped and the assertion on the prompt text fails intermittently.';
  const fix = 'The fix is to await the write callback before reading the buffer:';
  const url = 'https://github.com/diffplug/dormouse/pull/853/files#diff-7c1f3e9a2b8d4f6e0a5c7b9d1e3f5a7c9b1d3e5f';
  const pr = `I opened a draft with the change: ${url}`;
  const cmd = 'pnpm --filter dormouse-lib exec vitest run src/lib/selection-text.test.ts --repeat 50';
  const verify = `To verify locally, run ${cmd}`;
  const boxInner = cols - 2;
  const rows: MockRow[] = [
    toned('> why is selection-text.test.ts flaky on CI?', 'user'),
    blank,
    ...wrapParagraph(prose, W, '⏺ ', '  ', [], 'accent'),
    blank,
    ...wrapParagraph(fix, W, '  ', '  '),
    blank,
    toned('    await new Promise<void>((resolve) => terminal.write(chunk, resolve));', 'code'),
    toned('    const text = extractSelectionText(terminal, selection);', 'code'),
    toned("    expect(text).toBe('user@dormouse:~$ ls');", 'code'),
    blank,
    ...wrapParagraph(pr, W, '  ', '  ', [range(pr, url, 'link')]),
    blank,
    ...wrapParagraph(verify, W, '  ', '  ', [range(verify, cmd, 'code')]),
    blank,
    toned(`╭${'─'.repeat(boxInner)}╮`, 'frame'),
    { text: `│ > ${' '.repeat(boxInner - 3)}│`, tones: [{ from: 0, to: 1, tone: 'frame' }, { from: 2, to: 3, tone: 'muted' }, { from: cols - 1, to: cols, tone: 'frame' }] },
    toned(`╰${'─'.repeat(boxInner)}╯`, 'frame'),
    toned(`  ? for shortcuts${' '.repeat(cols - 2 - 16 - 19)}◯ auto-accept edits`, 'muted'),
  ];
  const replyEnd = rows.findIndex((r) => r.text.startsWith('╭')) - 2;
  return { id: 'claude', title: 'claude', program: 'Claude Code', cols, hardWrapWidth: W, rows, blocks: [{ from: 2, to: replyEnd, label: 'Whole reply' }] };
}

/** Split `text` into `cols`-wide rows the way a terminal soft-wraps it. */
function softWrap(text: string, cols: number, tones?: (row: string, index: number) => ToneSpan[]): MockRow[] {
  const out: MockRow[] = [];
  for (let at = 0, i = 0; at < text.length || i === 0; at += cols, i++) {
    const row = text.slice(at, at + cols);
    out.push({ text: row, wrapped: i > 0, tones: tones?.(row, i) });
  }
  return out;
}

const PROMPT = '~/projects/dormouse ❯ ';

function promptRow(command: string, cols: number): MockRow[] {
  const rows = softWrap(PROMPT + command, cols, (_row, i) => (i === 0 ? [{ from: 0, to: PROMPT.length - 2, tone: 'link' }, { from: PROMPT.length - 2, to: PROMPT.length - 1, tone: 'prompt' }] : []));
  rows[0].prompt = true;
  return rows;
}

function buildShellScreen(): MockScreen {
  const cols = 80;
  const token = 'eyJhbGciOiJFZERTQSIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJkb3Jtb3VzZS1kZXYiLCJzY29wZSI6InB0eTpyZWFkIHB0eTp3cml0ZSIsImlhdCI6MTc5MDAwMDAwMH0.4f1c2a9e8b7d6f5a4c3b2a1908f7e6d5c4b3a29187f6e5d4c3b2a1908f7e6d5c4b3a2';
  const rows: MockRow[] = [];
  const blocks: MockBlock[] = [];
  const command = (cmd: string, output: MockRow[]) => {
    rows.push(...promptRow(cmd, cols));
    if (output.length) blocks.push({ from: rows.length, to: rows.length + output.length - 1, label: 'Command output' });
    rows.push(...output);
  };
  command('gh pr view 853 --json title,url', [
    { text: '{' },
    { text: '  "title": "Await the PTY write callback before reading the selection buffer",', tones: [{ from: 2, to: 9, tone: 'link' }, { from: 11, to: 78, tone: 'pass' }] },
    { text: '  "url": "https://github.com/diffplug/dormouse/pull/853"', tones: [{ from: 2, to: 7, tone: 'link' }, { from: 9, to: 56, tone: 'pass' }] },
    { text: '}' },
  ]);
  command('cat .dev-token', softWrap(token, cols));
  command('git log --oneline -3', [
    { text: 'd19f2683e Theme tool iframes and upgrade file viewers with Monaco editing (#851)', tones: [{ from: 0, to: 9, tone: 'code' }] },
    { text: 'd19f2c6d6 Add a theme-aware twinkling starfield to the Pocket tutorial (#852)', tones: [{ from: 0, to: 9, tone: 'code' }] },
    { text: 'a292155da Report a reloaded editor after resetting its saved revision', tones: [{ from: 0, to: 9, tone: 'code' }] },
  ]);
  command('pnpm --filter dormouse-lib exec vitest run src/lib/selection-text.test.ts --repeat 50', [
    { text: '' },
    { text: ' ✓ src/lib/selection-text.test.ts (12 tests) 38ms', tones: [{ from: 1, to: 2, tone: 'pass' }, { from: 44, to: 48, tone: 'muted' }] },
    { text: '' },
    { text: ' Test Files  1 passed (1)', tones: [{ from: 1, to: 11, tone: 'muted' }, { from: 13, to: 21, tone: 'pass' }] },
    { text: '      Tests  12 passed (50 runs)', tones: [{ from: 6, to: 11, tone: 'muted' }, { from: 13, to: 22, tone: 'pass' }] },
  ]);
  rows.push(...promptRow('', cols));
  return { id: 'shell', title: 'zsh', program: 'zsh', cols, rows, blocks };
}

export const SCREENS = { claude: buildClaudeScreen(), shell: buildShellScreen() } as const;
export type ScreenId = keyof typeof SCREENS;

// ---------------------------------------------------------------------------
// Positions and spans

export interface GridPos { row: number; col: number }
/** Linewise, inclusive end, `start` before `end` in reading order. */
export interface Span { start: GridPos; end: GridPos }

export function comparePos(a: GridPos, b: GridPos): number {
  return a.row - b.row || a.col - b.col;
}

export function normalizeSpan(a: GridPos, b: GridPos): Span {
  return comparePos(a, b) <= 0 ? { start: a, end: b } : { start: b, end: a };
}

export function spanEquals(a: Span, b: Span): boolean {
  return comparePos(a.start, b.start) === 0 && comparePos(a.end, b.end) === 0;
}

function contains(span: Span, pos: GridPos): boolean {
  return comparePos(span.start, pos) <= 0 && comparePos(pos, span.end) <= 0;
}

const rowText = (screen: MockScreen, r: number) => (screen.rows[r]?.text ?? '').trimEnd();
const isSpace = (ch: string | undefined) => ch === undefined || ch === ' ';

// ---------------------------------------------------------------------------
// Chrome and breaks

const BOX = /[─-▟]/;
const FRAME_ONLY = /^[─-▟\s]+$/;
/** A TUI's line-leading glyph that is decoration, not text. */
const LEAD_MARKER = /^(\s*)(⏺ |⎿ |● |[─-▟]+ ?)/;
const TRAIL_BOX = / ?[─-▟]+$/;
const LIST_MARKER = /^(?:[-*•]|\d+[.)]) /;

function isFrameOnly(text: string): boolean {
  return text.length > 0 && FRAME_ONLY.test(text) && BOX.test(text);
}

/** The row with its decoration blanked to spaces, so indentation math still
 *  lines up with the columns under it. */
function unchromed(text: string): string {
  const lead = LEAD_MARKER.exec(text);
  let out = lead ? lead[1] + ' '.repeat(lead[2].length) + text.slice(lead[0].length) : text;
  out = out.replace(TRAIL_BOX, '');
  return out.trimEnd();
}

const indentOf = (text: string) => text.length - text.trimStart().length;

/** Where a wrapped continuation of this row would start. */
function hangIndent(text: string): number {
  const indent = indentOf(text);
  const list = LIST_MARKER.exec(text.slice(indent));
  return indent + (list ? list[0].length : 0);
}

export type BreakKind = 'keep' | 'space' | 'none';

/** The smart decision for the break between full rows `r` and `r + 1`. */
export function smartBreak(screen: MockScreen, r: number): BreakKind {
  const next = screen.rows[r + 1];
  if (!next) return 'keep';
  if (next.wrapped) return 'none';
  const cur = unchromed(rowText(screen, r));
  const nxt = unchromed(rowText(screen, r + 1));
  if (!cur.trim() || !nxt.trim()) return 'keep';
  const W = screen.hardWrapWidth;
  if (!W) return 'keep';
  const nextTrim = nxt.trimStart();
  if (LIST_MARKER.test(nextTrim)) return 'keep';
  if (/[;{}]$/.test(cur) || /^[)}\]]/.test(nextTrim)) return 'keep';
  if (indentOf(nxt) !== hangIndent(cur)) return 'keep';
  const firstWord = nextTrim.split(' ')[0];
  // A break the next word would have fit before was typed, not wrapped.
  if (cur.length + 1 + firstWord.length <= W) return 'keep';
  const lastWord = cur.slice(cur.lastIndexOf(' ') + 1);
  const tokenish = /[/\\#?=&]/.test(lastWord) || /^[A-Za-z0-9+_\-.]{16,}$/.test(lastWord);
  return cur.length >= W && tokenish ? 'none' : 'space';
}

// ---------------------------------------------------------------------------
// Renderings

export type FormatId = 'exact' | 'spaces' | 'joined' | 'smart' | 'dedent';

export const FORMATS: { id: FormatId; key: string; name: string; blurb: string }[] = [
  { id: 'exact', key: '1', name: 'Exact', blurb: 'as displayed' },
  { id: 'spaces', key: '2', name: 'Spaces', blurb: 'every break → one space' },
  { id: 'joined', key: '3', name: 'No breaks', blurb: 'every break deleted' },
  { id: 'smart', key: '4', name: 'Rewrapped', blurb: 'each break judged on its own' },
  { id: 'dedent', key: '5', name: 'Dedented', blurb: 'breaks kept, indent and gutter removed' },
];

export type Piece =
  | { t: 'text'; text: string; added: boolean; lead: boolean }
  | { t: 'break'; index: number; kind: BreakKind; auto: BreakKind };

export interface Rendering {
  format: FormatId;
  pieces: Piece[];
  text: string;
  lines: number;
  chars: number;
  breaks: BreakKind[];
  /** Characters outside the dragged selection (an expansion). */
  addedChars: number;
}

interface Cell { ch: string; added: boolean }
interface Line { cells: Cell[]; row: number; startCol: number }

function extract(screen: MockScreen, scope: Span, original: Span): Line[] {
  const lines: Line[] = [];
  for (let r = scope.start.row; r <= scope.end.row; r++) {
    const text = rowText(screen, r);
    const a = r === scope.start.row ? scope.start.col : 0;
    const b = r === scope.end.row ? scope.end.col + 1 : text.length;
    const cells: Cell[] = [];
    for (let c = a; c < Math.min(b, text.length); c++) {
      cells.push({ ch: text[c], added: !contains(original, { row: r, col: c }) });
    }
    while (cells.length && cells[cells.length - 1].ch === ' ') cells.pop();
    lines.push({ cells, row: r, startCol: a });
  }
  return lines;
}

const lineStr = (l: Line) => l.cells.map((c) => c.ch).join('');
const leading = (cells: Cell[]) => {
  let n = 0;
  while (n < cells.length && cells[n].ch === ' ') n++;
  return n;
};

/** Blank the line's decoration the same way `unchromed` does its row. */
function stripChrome(line: Line): Line | null {
  const text = lineStr(line);
  if (isFrameOnly(text)) return null;
  const cells = line.cells.map((c) => ({ ...c }));
  const lead = LEAD_MARKER.exec(text);
  if (lead) for (let k = lead[1].length; k < lead[0].length; k++) cells[k].ch = ' ';
  const trail = TRAIL_BOX.exec(text);
  if (trail) cells.length = trail.index;
  while (cells.length && cells[cells.length - 1].ch === ' ') cells.pop();
  return { ...line, cells };
}

export function render(screen: MockScreen, scope: Span, original: Span, format: FormatId, overrides: Record<number, BreakKind> = {}): Rendering {
  let lines = extract(screen, scope, original);
  if (format !== 'exact') lines = lines.map(stripChrome).filter((l): l is Line => l !== null);

  const blank = (l: Line) => l.cells.length === 0;
  // Trim leading/trailing blank lines; collapse runs of blanks to one.
  while (lines.length && blank(lines[0])) lines.shift();
  while (lines.length && blank(lines[lines.length - 1])) lines.pop();
  if (format === 'spaces' || format === 'joined') lines = lines.filter((l) => !blank(l));
  else if (format !== 'exact') lines = lines.filter((l, i) => !(blank(l) && i > 0 && blank(lines[i - 1])));

  // Shared indent, in absolute columns, for the formats that dedent. A first
  // line starting mid-row has no indent of its own to keep.
  const dedents = format === 'smart' || format === 'dedent';
  const absIndents = lines.filter((l) => !blank(l)).map((l) => l.startCol + leading(l.cells));
  const base = absIndents.length ? Math.min(...absIndents) : 0;

  const breaks: BreakKind[] = [];
  const autos: BreakKind[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const a = lines[i];
    const b = lines[i + 1];
    let auto: BreakKind;
    if (format === 'exact' || format === 'dedent') auto = 'keep';
    else if (format === 'spaces') auto = 'space';
    else if (format === 'joined') auto = 'none';
    else auto = blank(a) || blank(b) || b.row !== a.row + 1 ? 'keep' : smartBreak(screen, a.row);
    autos.push(auto);
    breaks.push(overrides[i] ?? auto);
  }

  const pieces: Piece[] = [];
  let text = '';
  let addedChars = 0;
  lines.forEach((line, i) => {
    const joinedToPrev = i > 0 && breaks[i - 1] !== 'keep';
    let cells = line.cells;
    const lead = leading(cells);
    let strip: number;
    if (format === 'exact') strip = joinedToPrev ? lead : 0;
    else if (joinedToPrev || format === 'spaces' || format === 'joined') strip = lead;
    else if (dedents) strip = line.startCol > base ? lead : Math.min(lead, base - line.startCol);
    else strip = lead;
    cells = cells.slice(strip);
    // Group into runs of (lead-whitespace, added) so the preview can mark them.
    const leadRun = leading(cells);
    let run: Piece & { t: 'text' } | null = null;
    cells.forEach((cell, k) => {
      const isLead = k < leadRun;
      if (run && run.added === cell.added && run.lead === isLead) run.text += cell.ch;
      else {
        run = { t: 'text', text: cell.ch, added: cell.added, lead: isLead };
        pieces.push(run);
      }
      if (cell.added) addedChars++;
    });
    text += cells.map((c) => c.ch).join('');
    if (i + 1 < lines.length) {
      const kind = breaks[i];
      pieces.push({ t: 'break', index: i, kind, auto: autos[i] });
      text += kind === 'keep' ? '\n' : kind === 'space' ? ' ' : '';
    }
  });

  return { format, pieces, text, lines: text ? text.split('\n').length : 0, chars: text.length, breaks, addedChars };
}

export function renderAll(screen: MockScreen, scope: Span, original: Span): Rendering[] {
  return FORMATS.map((f) => render(screen, scope, original, f.id));
}

/** The format whose text each rendering duplicates, if any. The recommended
 *  format is always the one kept, so ★ never reads "same as". */
export function duplicates(renderings: Rendering[]): Map<FormatId, FormatId> {
  const seen = new Map<string, FormatId>();
  const out = new Map<FormatId, FormatId>();
  const ordered = [...renderings].sort((a, b) => Number(b.format === RECOMMENDED) - Number(a.format === RECOMMENDED));
  for (const r of ordered) {
    const prior = seen.get(r.text);
    if (prior) out.set(r.format, prior);
    else seen.set(r.text, r.format);
  }
  return out;
}

export const RECOMMENDED: FormatId = 'smart';

// ---------------------------------------------------------------------------
// Expansions

export type ScopeId = 'selection' | 'words' | 'paragraph' | 'block';

export interface Scope { id: ScopeId; label: string; span: Span }

function contentStart(screen: MockScreen, r: number): number {
  return indentOf(unchromed(rowText(screen, r)));
}

/** Grow each edge to the whole token under it, following a token the program
 *  split across rows. */
function snapToWords(screen: MockScreen, sel: Span): Span {
  let { row: sr, col: sc } = sel.start;
  for (;;) {
    const t = rowText(screen, sr);
    while (sc > 0 && !isSpace(t[sc - 1])) sc--;
    if (sc <= contentStart(screen, sr) && sr > 0 && smartBreak(screen, sr - 1) === 'none' && !isSpace(t[sc])) {
      sr--;
      sc = rowText(screen, sr).length;
      continue;
    }
    break;
  }
  let { row: er, col: ec } = sel.end;
  for (;;) {
    const t = rowText(screen, er);
    while (ec + 1 < t.length && !isSpace(t[ec + 1])) ec++;
    if (ec >= t.length - 1 && smartBreak(screen, er) === 'none' && !isSpace(t[ec])) {
      er++;
      ec = contentStart(screen, er) - 1;
      continue;
    }
    break;
  }
  return { start: { row: sr, col: Math.max(0, sc) }, end: { row: er, col: ec } };
}

const boundary = (screen: MockScreen, r: number) => {
  const t = rowText(screen, r);
  return !t.trim() || isFrameOnly(t) || /^[│┃]/.test(t) || !!screen.rows[r]?.prompt;
};

function toParagraph(screen: MockScreen, sel: Span): Span {
  let sr = sel.start.row;
  while (sr > 0 && !boundary(screen, sr - 1)) sr--;
  let er = sel.end.row;
  while (er + 1 < screen.rows.length && !boundary(screen, er + 1)) er++;
  return { start: { row: sr, col: contentStart(screen, sr) }, end: { row: er, col: rowText(screen, er).length - 1 } };
}

function toBlock(screen: MockScreen, sel: Span): { span: Span; label: string } | null {
  const block = screen.blocks.find((b) => b.from <= sel.start.row && sel.end.row <= b.to);
  if (!block) return null;
  return { span: { start: { row: block.from, col: contentStart(screen, block.from) }, end: { row: block.to, col: rowText(screen, block.to).length - 1 } }, label: block.label };
}

/** Names the growth by the edge tokens that grew, not the whole text. */
function tokenLabel(text: string, grewStart: boolean, grewEnd: boolean): string {
  const tokens = text.split(/\s+/).filter(Boolean);
  const edges = [grewStart ? tokens[0] : '', grewEnd ? tokens[tokens.length - 1] : ''];
  if (edges.some((t) => /^https?:\/\//.test(t ?? ''))) return 'Full URL';
  if (edges.some((t) => /^(~|\.{0,2})\/\S|\S+\/\S+\.\w+/.test(t ?? ''))) return 'Full path';
  return 'Whole words';
}

/** Every distinct scope the selection can grow to, narrowest first. Never
 *  shrinks: a wider scope always contains the dragged selection. */
export function computeScopes(screen: MockScreen, sel: Span): Scope[] {
  const out: Scope[] = [{ id: 'selection', label: 'As selected', span: sel }];
  const push = (id: ScopeId, label: string, span: Span) => {
    const union: Span = {
      start: comparePos(span.start, sel.start) < 0 ? span.start : sel.start,
      end: comparePos(span.end, sel.end) > 0 ? span.end : sel.end,
    };
    if (out.some((s) => spanEquals(s.span, union))) return;
    out.push({ id, label, span: union });
  };
  const words = snapToWords(screen, sel);
  const grewStart = comparePos(words.start, sel.start) < 0;
  const grewEnd = comparePos(words.end, sel.end) > 0;
  push('words', tokenLabel(render(screen, words, words, 'smart').text, grewStart, grewEnd), words);
  push('paragraph', 'Paragraph', toParagraph(screen, sel));
  const block = toBlock(screen, sel);
  if (block) push('block', block.label, block.span);
  return out;
}

// ---------------------------------------------------------------------------
// Keyboard nudging (the editor concept)

function cellAt(screen: MockScreen, p: GridPos): string | undefined {
  return rowText(screen, p.row)[p.col];
}

function step(screen: MockScreen, p: GridPos, dir: 1 | -1): GridPos | null {
  let { row, col } = p;
  col += dir;
  while (row >= 0 && row < screen.rows.length) {
    const len = rowText(screen, row).length;
    if (col >= 0 && col < len) return { row, col };
    row += dir;
    if (row < 0 || row >= screen.rows.length) return null;
    col = dir > 0 ? 0 : rowText(screen, row).length - 1;
  }
  return null;
}

/** Move a selection edge one word. `edge` says which end of a word it sits on. */
export function nudge(screen: MockScreen, p: GridPos, dir: 1 | -1, edge: 'start' | 'end'): GridPos {
  let q: GridPos | null = p;
  const land = (pos: GridPos) => {
    // Walk to the boundary of the word under `pos` on the requested side.
    let cur = pos;
    for (;;) {
      const n = step(screen, cur, edge === 'end' ? 1 : -1);
      if (!n || n.row !== cur.row || isSpace(cellAt(screen, n))) return cur;
      cur = n;
    }
  };
  // Leave the current word, cross the gap, then land on the next word's edge.
  q = step(screen, p, dir);
  while (q && !isSpace(cellAt(screen, q)) && q.row === p.row && ((dir > 0) === (edge === 'start'))) q = step(screen, q, dir);
  while (q && isSpace(cellAt(screen, q))) q = step(screen, q, dir);
  return q ? land(q) : p;
}

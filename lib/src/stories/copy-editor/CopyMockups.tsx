import { clsx } from 'clsx';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CheckIcon, CursorClickIcon } from '@phosphor-icons/react';
import { modalSurface, paneHeader, PopupButtonRow, Shortcut, TERMINAL_BOTTOM_RADIUS_CLASS } from '../../components/design';
import { rectsToPath, type Rect } from '../../lib/selection-geometry';
import {
  FORMATS,
  RECOMMENDED,
  computeScopes,
  duplicates,
  render,
  renderAll,
  type BreakKind,
  type FormatId,
  type GridPos,
  type MockScreen,
  type Piece,
  type Rendering,
  type Scope,
  type Span,
  type Tone,
} from './model';

export const CELL_H = 16;
const IS_MAC_MOCK = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/i.test(navigator.platform);
export const COPY_CHORD = IS_MAC_MOCK ? 'Cmd+C' : 'Ctrl+C';

const TONE_COLOR: Record<Tone, string> = {
  muted: 'var(--vscode-terminal-ansiBrightBlack)',
  link: 'var(--vscode-terminal-ansiBlue)',
  code: 'var(--vscode-terminal-ansiCyan)',
  accent: 'var(--vscode-terminal-ansiGreen)',
  user: 'var(--vscode-terminal-ansiBrightBlack)',
  frame: 'var(--vscode-terminal-ansiBrightBlack)',
  prompt: 'var(--vscode-terminal-ansiMagenta)',
  pass: 'var(--vscode-terminal-ansiGreen)',
};

// ---------------------------------------------------------------------------
// Mock terminal

function spanRects(span: Span, cols: number, cellW: number): Rect[] {
  const rects: Rect[] = [];
  for (let r = span.start.row; r <= span.end.row; r++) {
    const c0 = r === span.start.row ? span.start.col : 0;
    const c1 = r === span.end.row ? span.end.col + 1 : cols;
    if (c1 <= c0) continue;
    rects.push({ top: r * CELL_H, left: c0 * cellW, width: (c1 - c0) * cellW, height: CELL_H });
  }
  return rects;
}

function inSpan(span: Span | null, row: number, col: number): boolean {
  if (!span) return false;
  if (row < span.start.row || row > span.end.row) return false;
  if (row === span.start.row && col < span.start.col) return false;
  if (row === span.end.row && col > span.end.col) return false;
  return true;
}

function useCellWidth(): [number, (el: HTMLSpanElement | null) => void] {
  const [cellW, setCellW] = useState(7.2);
  const [el, setEl] = useState<HTMLSpanElement | null>(null);
  useLayoutEffect(() => {
    if (!el) return;
    const measure = () => {
      const w = el.getBoundingClientRect().width / 20;
      if (w > 0) setCellW(w);
    };
    measure();
    void document.fonts?.ready.then(measure);
  }, [el]);
  return [cellW, setEl];
}

interface MockTerminalProps {
  screen: MockScreen;
  mouseMode: boolean;
  /** Dormouse's own selection outline. */
  outline: Span | null;
  /** The program's own highlight (inverse video), painted by the TUI. */
  programHighlight: Span | null;
  /** A candidate scope previewed while its option is focused. */
  scopePreview: Span | null;
  onDrag?: (phase: 'down' | 'move' | 'up', pos: GridPos) => void;
  children?: (geometry: { cellW: number; width: number; height: number }) => ReactNode;
}

export function MockTerminal({ screen, mouseMode, outline, programHighlight, scopePreview, onDrag, children }: MockTerminalProps) {
  const [cellW, measureRef] = useCellWidth();
  const gridRef = useRef<HTMLDivElement>(null);
  const dragging = useRef(false);
  const width = screen.cols * cellW;
  const height = screen.rows.length * CELL_H;

  const posFromEvent = (ev: { clientX: number; clientY: number }): GridPos => {
    const rect = gridRef.current!.getBoundingClientRect();
    const col = Math.max(0, Math.min(screen.cols - 1, Math.floor((ev.clientX - rect.left) / cellW)));
    const row = Math.max(0, Math.min(screen.rows.length - 1, Math.floor((ev.clientY - rect.top) / CELL_H)));
    return { row, col };
  };

  useEffect(() => {
    if (!onDrag) return;
    const move = (ev: MouseEvent) => {
      if (dragging.current) onDrag('move', posFromEvent(ev));
    };
    const up = (ev: MouseEvent) => {
      if (!dragging.current) return;
      dragging.current = false;
      onDrag('up', posFromEvent(ev));
    };
    window.addEventListener('mousemove', move);
    window.addEventListener('mouseup', up);
    return () => {
      window.removeEventListener('mousemove', move);
      window.removeEventListener('mouseup', up);
    };
  });

  return (
    <div className="inline-flex flex-col">
      <div className="flex" style={{ height: 30 }}>
        <div className={paneHeader({ state: 'active' })}>
          <span className="truncate">{screen.title}</span>
          <span className="ml-auto flex items-center gap-1 opacity-80">
            {mouseMode ? <CursorClickIcon size={14} aria-label="Program requests mouse" /> : null}
          </span>
        </div>
      </div>
      <div className={clsx('relative bg-terminal-bg p-2 text-terminal-fg', TERMINAL_BOTTOM_RADIUS_CLASS)}>
        <span ref={measureRef} aria-hidden className="invisible absolute font-mono text-sm whitespace-pre">{'M'.repeat(20)}</span>
        <div
          ref={gridRef}
          className={clsx('relative font-mono text-sm leading-4 select-none', onDrag && 'cursor-text')}
          style={{ width, height }}
          onMouseDown={(ev) => {
            if (!onDrag || ev.button !== 0) return;
            ev.preventDefault();
            dragging.current = true;
            onDrag('down', posFromEvent(ev));
          }}
        >
          {screen.rows.map((row, r) => (
            <div key={r} className="whitespace-pre" style={{ height: CELL_H }}>
              {renderRowCells(row.text.padEnd(screen.cols), row.tones ?? [], r, programHighlight)}
            </div>
          ))}
          <svg className="pointer-events-none absolute inset-0 overflow-visible" width={width} height={height} aria-hidden>
            {scopePreview && (
              <path d={rectsToPath(spanRects(scopePreview, screen.cols, cellW))} fill="color-mix(in srgb, var(--color-success) 14%, transparent)" stroke="var(--color-success)" strokeWidth={1.5} strokeDasharray="4 3" />
            )}
            {outline && (
              <path d={rectsToPath(spanRects(outline, screen.cols, cellW))} fill="none" stroke="var(--color-focus-ring)" strokeWidth={1.5} strokeLinejoin="miter" />
            )}
          </svg>
          {children?.({ cellW, width, height })}
        </div>
      </div>
    </div>
  );
}

function renderRowCells(text: string, tones: { from: number; to: number; tone: Tone }[], r: number, highlight: Span | null): ReactNode {
  // Runs of (tone, highlighted) so a row is a handful of spans, not 80.
  const out: ReactNode[] = [];
  let runStart = 0;
  const toneAt = (c: number) => tones.find((t) => c >= t.from && c < t.to)?.tone;
  const keyAt = (c: number) => `${toneAt(c) ?? ''}|${inSpan(highlight, r, c) && c < text.trimEnd().length + 1 ? 'h' : ''}`;
  for (let c = 1; c <= text.length; c++) {
    if (c < text.length && keyAt(c) === keyAt(runStart)) continue;
    const tone = toneAt(runStart);
    const hl = keyAt(runStart).endsWith('h');
    const style: CSSProperties = hl
      ? { background: 'var(--color-terminal-fg)', color: 'var(--color-terminal-bg)' }
      : tone ? { color: TONE_COLOR[tone] } : {};
    out.push(<span key={runStart} style={style}>{text.slice(runStart, c)}</span>);
    runStart = c;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Preview of one rendering, invisibles made visible

const BREAK_GLYPH: Record<BreakKind, string> = { keep: '⏎', space: '␣', none: '⌁' };
const BREAK_TITLE: Record<BreakKind, string> = {
  keep: 'Line break kept',
  space: 'Line break → one space',
  none: 'Line break deleted (token rejoined)',
};

function BreakMark({ kind, auto, onToggle }: { kind: BreakKind; auto: BreakKind; onToggle?: () => void }) {
  const edited = kind !== auto;
  if (onToggle) {
    // The editor: every break is a chip you can click to cycle.
    return (
      <>
        <button
          type="button"
          title={`${BREAK_TITLE[kind]}${edited ? ' (edited)' : ''} — click to change`}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={onToggle}
          className={clsx(
            'mx-px inline-flex h-[1.1em] min-w-[1.3em] items-center justify-center rounded-sm border px-px align-[-0.2em] text-[10px] leading-none',
            kind === 'keep' ? 'border-border text-muted' : 'border-focus-ring text-focus-ring',
            edited && 'border-dashed bg-focus-ring/15',
          )}
        >
          {BREAK_GLYPH[kind]}
        </button>
        {kind === 'keep' ? '\n' : null}
      </>
    );
  }
  if (kind === 'keep') return <><span className="text-muted/70 select-none" title={BREAK_TITLE.keep}>⏎</span>{'\n'}</>;
  if (kind === 'space') return <span className="rounded-[2px] bg-focus-ring/30" title={BREAK_TITLE.space}> </span>;
  return <span className="mx-[0.5px] inline-block h-[0.95em] w-[2px] rounded-full bg-focus-ring align-[-0.12em]" title={BREAK_TITLE.none} />;
}

export function PreviewText({
  rendering,
  onToggleBreak,
  className,
}: {
  rendering: Rendering;
  onToggleBreak?: (index: number) => void;
  className?: string;
}) {
  return (
    <div className={clsx('font-mono text-sm leading-[18px] whitespace-pre-wrap [overflow-wrap:anywhere] text-foreground', className)}>
      {rendering.pieces.map((p: Piece, i) => {
        if (p.t === 'break') return <BreakMark key={i} kind={p.kind} auto={p.auto} onToggle={onToggleBreak ? () => onToggleBreak(p.index) : undefined} />;
        const text = p.lead ? p.text.replace(/ /g, '·').replace(/\t/g, '→') : p.text;
        return (
          <span
            key={i}
            className={clsx(p.lead && 'text-muted/60', p.added && 'rounded-[2px] bg-success/15 underline decoration-success decoration-dotted underline-offset-2')}
          >
            {text}
          </span>
        );
      })}
      {rendering.text === '' && <span className="text-muted italic">(empty)</span>}
    </div>
  );
}

function stats(r: Rendering): string {
  return `${r.lines} ${r.lines === 1 ? 'line' : 'lines'} · ${r.chars} ch`;
}

function Legend({ editable }: { editable?: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      <span><span className="text-muted/70">⏎</span> kept</span>
      <span><span className="inline-block w-[1ch] rounded-[2px] bg-focus-ring/30">&nbsp;</span> space</span>
      <span><span className="mx-[0.5px] inline-block h-[0.95em] w-[2px] rounded-full bg-focus-ring align-[-0.12em]" /> joined</span>
      <span><span className="rounded-[2px] bg-success/15 px-0.5 text-foreground underline decoration-success decoration-dotted">abc</span> beyond your drag</span>
      <span>·· indent</span>
      {editable && <span>click a break to change it</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Shared option model for the three concepts

export interface CopyOption {
  key: string;
  format: FormatId;
  scope: Scope;
  label: string;
  rendering: Rendering;
  sameAs?: string;
  recommended?: boolean;
  /** The program's own OSC 52 text, offered rather than silently dropped. */
  program?: boolean;
}

/** The numbered options: one per format at the dragged scope, then one per
 *  wider scope in the recommended format. Numbers never move between copies. */
export function buildOptions(screen: MockScreen, sel: Span, programCopy?: { program: string; text: string }): CopyOption[] {
  const scopes = computeScopes(screen, sel);
  const base = renderAll(screen, sel, sel);
  const dups = duplicates(base);
  const keyOf = (f: FormatId) => FORMATS.find((x) => x.id === f)!.key;
  const options: CopyOption[] = base.map((r) => {
    const f = FORMATS.find((x) => x.id === r.format)!;
    const prior = dups.get(r.format);
    return { key: f.key, format: r.format, scope: scopes[0], label: f.name, rendering: r, sameAs: prior ? keyOf(prior) : undefined, recommended: r.format === RECOMMENDED };
  });
  if (programCopy) {
    const prior = options.find((o) => o.rendering.text === programCopy.text && !o.sameAs);
    options.push({ key: String(options.length + 1), format: 'exact', scope: scopes[0], label: `${programCopy.program}'s copy`, rendering: plainRendering(programCopy.text), sameAs: prior?.key, program: true });
  }
  scopes.slice(1).forEach((scope) => {
    options.push({ key: String(options.length + 1), format: RECOMMENDED, scope, label: scope.label, rendering: render(screen, scope.span, sel, RECOMMENDED) });
  });
  return options;
}

function scopeGrowth(o: CopyOption): string {
  const added = o.rendering.addedChars;
  return added ? `+${added} ch` : '';
}

// ---------------------------------------------------------------------------
// Concept A — numbered chooser (the brief)

export function ChooserPanel({
  options,
  focused,
  flashedKey,
  onFocus,
  onPick,
  source,
}: {
  options: CopyOption[];
  focused: number;
  flashedKey: string | null;
  onFocus: (i: number) => void;
  onPick: (i: number) => void;
  source: string;
}) {
  const current = options[focused];
  const formatRows = options.filter((o) => o.scope.id === 'selection');
  const scopeRows = options.filter((o) => o.scope.id !== 'selection');
  const row = (o: CopyOption) => {
    const i = options.indexOf(o);
    const active = i === focused;
    return (
      <button
        key={o.key}
        type="button"
        onMouseEnter={() => onFocus(i)}
        onFocus={() => onFocus(i)}
        onClick={() => onPick(i)}
        className={clsx(
          'flex w-full items-center gap-2 px-2 py-[3px] text-left text-sm',
          active ? 'bg-header-active-bg text-header-active-fg' : 'hover:bg-foreground/10',
          o.sameAs && !active && 'opacity-50',
        )}
      >
        <span className="relative inline-block w-[3ch] shrink-0">
          <span className={clsx(active ? 'opacity-70' : 'text-muted', flashedKey === o.key && 'invisible')}>[{o.key}]</span>
          {flashedKey === o.key && <span className="absolute inset-0 flex items-center justify-center"><CheckIcon size={12} weight="bold" /></span>}
        </span>
        <span className="truncate">{o.label}</span>
        {o.recommended && <span className={clsx('text-xs', active ? 'opacity-80' : 'text-link')} title="Enter or a second copy chord takes this">★</span>}
        <span className={clsx('ml-auto shrink-0 text-xs', active ? 'opacity-70' : 'text-muted')}>
          {o.sameAs ? `= ${o.sameAs}` : o.program ? 'OSC 52' : o.scope.id === 'selection' ? `${o.rendering.lines} ${o.rendering.lines === 1 ? 'line' : 'lines'}` : scopeGrowth(o)}
        </span>
      </button>
    );
  };
  return (
    <div
      className={clsx(modalSurface({ padding: 'none', elevation: 'modal' }), 'flex w-[560px] flex-col overflow-hidden border-foreground/20')}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex max-h-[260px] min-h-0">
        <div className="flex w-[228px] shrink-0 flex-col border-r border-border py-1">
          <div className="px-2 pb-1 text-xs text-muted">Copy {source}</div>
          {formatRows.map(row)}
          {scopeRows.length > 0 && (
            <>
              <div className="mt-1 flex items-center gap-1 px-2 pt-1 pb-0.5 text-xs text-muted">
                <span>Grow the selection</span>
                <span className="h-px flex-1 bg-border" />
              </div>
              {scopeRows.map(row)}
            </>
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col gap-1.5 p-2">
          <div className="flex items-baseline gap-2 text-xs text-muted">
            <span className="shrink-0 whitespace-nowrap text-foreground">{current.label}</span>
            <span className="truncate">{current.program ? 'the text the program itself sent' : current.scope.id === 'selection' ? FORMATS.find((f) => f.id === current.format)!.blurb : `${FORMATS.find((f) => f.id === current.format)!.name}, grown to ${current.scope.label.toLowerCase()}`}</span>
            <span className="ml-auto shrink-0">{stats(current.rendering)}</span>
          </div>
          <div className="min-h-[64px] flex-1 overflow-auto rounded border border-border bg-app-bg px-2 py-1.5">
            <PreviewText rendering={current.rendering} />
          </div>
        </div>
      </div>
      <div className="flex items-center justify-between gap-2 border-t border-border px-2 py-1 text-xs text-muted">
        <Legend />
        <span className="shrink-0"><Shortcut>1–{options.length}</Shortcut> copy <Shortcut>↑↓</Shortcut> preview <Shortcut>↵</Shortcut></span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concept B — copy first, receipt after

export function ReceiptPanel({
  options,
  copiedKey,
  onPick,
  onFocusScope,
}: {
  options: CopyOption[];
  copiedKey: string;
  onPick: (i: number) => void;
  onFocusScope: (i: number | null) => void;
}) {
  const copied = options.find((o) => o.key === copiedKey)!;
  return (
    <div
      className={clsx(modalSurface({ padding: 'none', elevation: 'modal' }), 'flex w-[500px] flex-col gap-1.5 border-foreground/20 p-2')}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-1.5 text-sm">
        <span className="text-success"><CheckIcon size={12} weight="bold" /></span>
        <span>Copied</span>
        <span className="text-muted">[{copied.key}]</span>
        <span>{copied.label}</span>
        <span className="ml-auto text-xs text-muted">{stats(copied.rendering)}</span>
      </div>
      <div className="max-h-[92px] overflow-auto rounded border border-border bg-app-bg px-2 py-1">
        <PreviewText rendering={copied.rendering} />
      </div>
      <div className="flex flex-wrap items-center gap-1 text-xs">
        <span className="text-muted">Copy instead:</span>
        {options.map((o, i) => (
          <button
            key={o.key}
            type="button"
            disabled={!!o.sameAs && o.key !== copiedKey}
            title={o.sameAs ? `Same text as ${o.sameAs}` : o.scope.id === 'selection' ? stats(o.rendering) : `${o.label}: ${scopeGrowth(o)}`}
            onMouseEnter={() => onFocusScope(o.scope.id === 'selection' ? null : i)}
            onMouseLeave={() => onFocusScope(null)}
            onClick={() => onPick(i)}
            className={clsx(
              'rounded border px-1 py-px',
              o.key === copiedKey ? 'border-focus-ring bg-header-active-bg text-header-active-fg' : 'border-border hover:bg-foreground/10',
              o.sameAs && o.key !== copiedKey && 'opacity-40',
              o.scope.id !== 'selection' && o.key !== copiedKey && 'border-dashed border-success',
            )}
          >
            <span className={o.key === copiedKey ? 'opacity-70' : 'text-muted'}>{o.key}</span> {o.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Concept C — the editor: scope ladder, format presets, per-break chips

export function EditorPanel({
  screen,
  sel,
  scopeIndex,
  format,
  overrides,
  flashed,
  onScope,
  onFormat,
  onToggleBreak,
  onCopy,
}: {
  screen: MockScreen;
  sel: Span;
  scopeIndex: number;
  format: FormatId;
  overrides: Record<number, BreakKind>;
  flashed: boolean;
  onScope: (i: number) => void;
  onFormat: (f: FormatId) => void;
  onToggleBreak: (index: number) => void;
  onCopy: () => void;
}) {
  const scopes = useMemo(() => computeScopes(screen, sel), [screen, sel]);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)];
  const rendering = render(screen, scope.span, sel, format, overrides);
  const all = renderAll(screen, scope.span, sel);
  const dups = duplicates(all);
  const edited = Object.keys(overrides).length > 0;
  return (
    <div
      className={clsx(modalSurface({ padding: 'none', elevation: 'modal' }), 'flex w-[600px] flex-col gap-2 border-foreground/20 p-2.5 text-sm')}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-xs text-muted">Scope</span>
        <div className="flex overflow-hidden rounded border border-border">
          {scopes.map((s, i) => (
            <button
              key={s.id}
              type="button"
              onClick={() => onScope(i)}
              className={clsx('border-r border-border px-1.5 py-0.5 last:border-r-0', i === scopes.indexOf(scope) ? 'bg-header-active-bg text-header-active-fg' : 'hover:bg-foreground/10')}
            >
              {s.label}
            </button>
          ))}
        </div>
        <span className="ml-auto text-xs text-muted"><Shortcut>e</Shortcut> grow <Shortcut>Shift+E</Shortcut> shrink</span>
      </div>
      <div className="flex items-center gap-2">
        <span className="w-12 shrink-0 text-xs text-muted">Format</span>
        <div className="flex flex-wrap gap-1">
          {FORMATS.map((f) => {
            const active = f.id === format;
            const same = dups.get(f.id);
            return (
              <button
                key={f.id}
                type="button"
                title={same ? `${f.blurb} — same text as ${FORMATS.find((x) => x.id === same)!.key}` : f.blurb}
                onClick={() => onFormat(f.id)}
                className={clsx('rounded border px-1.5 py-0.5', active ? 'border-focus-ring bg-header-active-bg text-header-active-fg' : 'border-border hover:bg-foreground/10', same && !active && 'opacity-50')}
              >
                <span className={active ? 'opacity-70' : 'text-muted'}>{f.key}</span> {f.name}{f.id === RECOMMENDED ? ' ★' : ''}{active && edited ? ' (edited)' : ''}
              </button>
            );
          })}
        </div>
      </div>
      <div className="max-h-[200px] min-h-[72px] overflow-auto rounded border border-border bg-app-bg px-2 py-1.5">
        <PreviewText rendering={rendering} onToggleBreak={onToggleBreak} />
      </div>
      <Legend editable />
      <div className="flex items-center justify-between gap-2 text-xs text-muted">
        <span><Shortcut>←→</Shortcut> end by word <Shortcut>Shift+←→</Shortcut> start by word · {stats(rendering)}</span>
        <button type="button" onClick={onCopy} className="flex items-center gap-1 rounded bg-header-active-bg px-2 py-1 text-header-active-fg">
          {flashed ? <CheckIcon size={12} weight="bold" /> : <span className="opacity-70">[↵]</span>} Copy
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Hints shown on the terminal itself

export function ArmedHint({ text, style }: { text: ReactNode; style: CSSProperties }) {
  return (
    <PopupButtonRow className="pointer-events-none absolute px-1.5 py-0.5 text-muted" style={style}>
      <span>{text}</span>
    </PopupButtonRow>
  );
}

/** A rendering of literal text, for text no transform produced. */
export function plainRendering(text: string): Rendering {
  return {
    format: 'exact',
    pieces: text.split('\n').flatMap((line, i, arr): Piece[] => {
      const lead = line.length - line.trimStart().length;
      const out: Piece[] = [];
      if (lead) out.push({ t: 'text', text: line.slice(0, lead), added: false, lead: true });
      if (line.length > lead) out.push({ t: 'text', text: line.slice(lead), added: false, lead: false });
      if (i + 1 < arr.length) out.push({ t: 'break', index: i, kind: 'keep', auto: 'keep' });
      return out;
    }),
    text,
    lines: text.split('\n').length,
    chars: text.length,
    breaks: [],
    addedChars: 0,
  };
}

export function ClipboardPanel({ text }: { text: string | null }) {
  const rendering = text === null ? null : plainRendering(text);
  return (
    <div className="flex w-[300px] flex-col gap-1 text-sm">
      <div className="flex items-baseline justify-between text-xs text-muted">
        <span className="text-foreground">Clipboard</span>
        {rendering && <span>{stats(rendering)}</span>}
      </div>
      <div className="min-h-[80px] rounded border border-border bg-app-bg px-2 py-1.5">
        {rendering ? <PreviewText rendering={rendering} /> : <span className="text-xs text-muted italic">Nothing copied yet</span>}
      </div>
      <div className="text-xs text-muted">What a paste would get (mock; the real clipboard is written too when the browser allows it).</div>
    </div>
  );
}


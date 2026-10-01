import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useState, type CSSProperties, type ReactNode } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import { CheckIcon } from '@phosphor-icons/react';
import { modalSurface, Shortcut } from '../../components/design';
import { ArmedHint, CELL_H, COPY_CHORD, ClipboardPanel, MockTerminal } from './CopyMockups';
import {
  SCREENS,
  computeScopes,
  duplicates,
  normalizeSpan,
  nudge,
  render,
  type BreakKind,
  type FormatId,
  type GridPos,
  type MockRow,
  type MockScreen,
  type Piece,
  type Rendering,
  type Span,
  type Tone,
} from './model';

// The copy editor after the first round (Prototypes/Copy editor): only the
// editor concept, at full pane width, driven by letters instead of digits.
//   e / ⬆︎e   grow / shrink the scope
//   f         next format (Auto → Exact → Spaces → No breaks)
//   ◀ ▶       move the end a word; ⬆︎◀ ⬆︎▶ move the start
//   ↵ or the copy chord copies; Esc closes.

/** Shift, as the mobile compass rose writes it (`lib/src/lib/mobile-gesture-menu.ts`). */
const SHIFT = '⬆︎';
const LEFT = '◀';
const RIGHT = '▶';

const FORMATS2: { id: FormatId; name: string; blurb: string }[] = [
  { id: 'smart', name: 'Auto', blurb: 'each line break judged on its own' },
  { id: 'exact', name: 'Exact', blurb: 'as displayed' },
  { id: 'spaces', name: 'Spaces', blurb: 'every line break becomes one space' },
  { id: 'joined', name: 'No breaks', blurb: 'every line break deleted' },
];
const AUTO: FormatId = 'smart';
const formatName = (f: FormatId) => FORMATS2.find((x) => x.id === f)!.name;

// ---------------------------------------------------------------------------
// Taller screens: some history above, so the editor has room beside a
// selection the way it would in a real pane.

const t = (text: string, tone?: Tone): MockRow => (tone ? { text, tones: [{ from: 0, to: text.length, tone }] } : { text });

function withHistory(base: MockScreen, history: MockRow[], historyBlock?: { from: number; to: number; label: string }): MockScreen {
  const n = history.length;
  return {
    ...base,
    rows: [...history, ...base.rows],
    blocks: [...(historyBlock ? [historyBlock] : []), ...base.blocks.map((b) => ({ ...b, from: b.from + n, to: b.to + n }))],
  };
}

const CLAUDE_HISTORY: MockRow[] = [
  t('> run the selection tests', 'user'),
  t(''),
  { text: '⏺ Bash(pnpm --filter dormouse-lib test selection-text)', tones: [{ from: 0, to: 1, tone: 'accent' }] },
  { text: '  ⎿  ✓ src/lib/selection-text.test.ts (12 tests) 41ms', tones: [{ from: 2, to: 3, tone: 'muted' }, { from: 5, to: 6, tone: 'pass' }, { from: 47, to: 51, tone: 'muted' }] },
  { text: '        Test Files  1 passed (1)', tones: [{ from: 8, to: 18, tone: 'muted' }, { from: 20, to: 28, tone: 'pass' }] },
  t(''),
  { text: '⏺ All 12 pass locally, so the failure only reproduces on CI.', tones: [{ from: 0, to: 1, tone: 'accent' }] },
  t(''),
];

const PROMPT = '~/projects/dormouse ❯ ';
const promptRow = (cmd: string): MockRow => ({ text: PROMPT + cmd, prompt: true, tones: [{ from: 0, to: PROMPT.length - 2, tone: 'link' }, { from: PROMPT.length - 2, to: PROMPT.length - 1, tone: 'prompt' }] });

const SHELL_HISTORY: MockRow[] = [
  promptRow('git switch -c fix-selection-flake'),
  t("Switched to a new branch 'fix-selection-flake'"),
  promptRow('git status --short'),
  { text: ' M lib/src/lib/selection-text.ts', tones: [{ from: 1, to: 2, tone: 'code' }] },
  { text: '?? lib/src/lib/selection-text.flaky.md', tones: [{ from: 0, to: 2, tone: 'muted' }] },
];

const SCREENS2 = {
  claude: withHistory(SCREENS.claude, CLAUDE_HISTORY, { from: 2, to: 6, label: 'Whole reply' }),
  shell: withHistory(SCREENS.shell, SHELL_HISTORY),
} as const;
const CLAUDE_OFFSET = CLAUDE_HISTORY.length;
const SHELL_OFFSET = SHELL_HISTORY.length;

// ---------------------------------------------------------------------------
// The preview: one gutter-numbered row per line that lands on the clipboard,
// every line break the selection crossed shown as a mark you can flip.

const MARK_GLYPH: Record<BreakKind, string> = { keep: '⏎', space: '␣', none: '⌁' };
const MARK_TITLE: Record<BreakKind, string> = {
  keep: 'Line break kept',
  space: 'Line break became one space',
  none: 'Line break deleted, so the two sides join',
};

function Mark({ kind, auto, onFlip }: { kind: BreakKind; auto: BreakKind; onFlip: () => void }) {
  const edited = kind !== auto;
  return (
    <button
      type="button"
      title={`${MARK_TITLE[kind]}${edited ? ' (changed by hand)' : ''}. Click to cycle.`}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={onFlip}
      className={clsx(
        'mx-px inline-flex h-[15px] min-w-[16px] items-center justify-center rounded-sm border px-px align-[-3px] text-sm leading-none',
        kind === 'keep' ? 'border-border text-muted hover:text-foreground' : 'border-focus-ring bg-focus-ring/15 text-foreground',
        edited && 'border-dashed outline outline-1 outline-offset-1 outline-focus-ring/60',
      )}
    >
      {MARK_GLYPH[kind]}
    </button>
  );
}

function TextRun({ p }: { p: Extract<Piece, { t: 'text' }> }) {
  const text = p.lead ? p.text.replace(/ /g, '·').replace(/\t/g, '→') : p.text;
  return (
    <span className={clsx(p.lead && 'text-muted/60', p.added && 'rounded-[2px] bg-success/15 underline decoration-success decoration-dotted underline-offset-2')}>
      {text}
    </span>
  );
}

function LinedPreview({ rendering, onFlip }: { rendering: Rendering; onFlip: (index: number) => void }) {
  const lines: ReactNode[][] = [[]];
  rendering.pieces.forEach((p, i) => {
    const line = lines[lines.length - 1];
    if (p.t === 'text') {
      line.push(<TextRun key={i} p={p} />);
      return;
    }
    line.push(<Mark key={i} kind={p.kind} auto={p.auto} onFlip={() => onFlip(p.index)} />);
    if (p.kind === 'keep') lines.push([]);
  });
  if (rendering.text === '') return <div className="px-2 py-1.5 text-xs text-muted italic">(empty)</div>;
  const gutter = String(lines.length).length;
  return (
    <div className="py-1 font-mono text-sm leading-[18px] text-foreground">
      {lines.map((parts, n) => (
        <div key={n} className="flex hover:bg-foreground/5">
          <span className="shrink-0 border-r border-border pr-1.5 pl-2 text-right text-muted/70 select-none" style={{ width: `calc(${gutter}ch + 0.875rem)` }}>
            {n + 1}
          </span>
          <div className="min-w-0 flex-1 pr-2 pl-2 whitespace-pre-wrap [overflow-wrap:anywhere]">{parts}</div>
        </div>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// The editor panel

function Segment<T extends string>({ value, items, onPick }: { value: T; items: { id: T; label: string; dim?: boolean; title?: string }[]; onPick: (v: T) => void }) {
  return (
    <div className="flex min-w-0 overflow-hidden rounded border border-border">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          title={it.title}
          onClick={() => onPick(it.id)}
          className={clsx(
            'shrink-0 border-r border-border px-1.5 py-0.5 whitespace-nowrap last:border-r-0',
            it.id === value ? 'bg-header-active-bg text-header-active-fg' : 'hover:bg-foreground/10',
            it.dim && it.id !== value && 'opacity-50',
          )}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

interface EditorProps {
  screen: MockScreen;
  sel: Span;
  scopeIndex: number;
  format: FormatId;
  overrides: Record<number, BreakKind>;
  flashed: boolean;
  onScope: (i: number) => void;
  onFormat: (f: FormatId) => void;
  onFlip: (index: number) => void;
  onCopy: () => void;
}

function CopyEditor({ screen, sel, scopeIndex, format, overrides, flashed, onScope, onFormat, onFlip, onCopy }: EditorProps) {
  const scopes = useMemo(() => computeScopes(screen, sel), [screen, sel]);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)];
  const rendering = render(screen, scope.span, sel, format, overrides);
  const dups = duplicates(FORMATS2.map((f) => render(screen, scope.span, sel, f.id)));
  const edited = Object.keys(overrides).length > 0;
  return (
    <div
      className={clsx(modalSurface({ padding: 'none', elevation: 'modal' }), 'flex max-h-[inherit] w-full flex-col overflow-hidden border-foreground/20 text-sm')}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex flex-col gap-1 border-b border-border px-2 py-1.5">
        <div className="flex items-center gap-2">
          <Segment value={scope.id} onPick={(id) => onScope(scopes.findIndex((s) => s.id === id))} items={scopes.map((s) => ({ id: s.id, label: s.label }))} />
          <span className="text-xs whitespace-nowrap text-muted"><Shortcut>e</Shortcut> grow <Shortcut>{SHIFT}e</Shortcut> shrink</span>
        </div>
        <div className="flex items-center gap-2">
          <Segment
            value={format}
            onPick={onFormat}
            items={FORMATS2.map((f) => {
              const same = dups.get(f.id);
              return {
                id: f.id,
                label: `${f.name}${f.id === format && edited ? '*' : ''}`,
                dim: !!same,
                title: same ? `${f.blurb}: same text as ${formatName(same)}` : f.blurb,
              };
            })}
          />
          <span className="text-xs whitespace-nowrap text-muted"><Shortcut>f</Shortcut> format</span>
        </div>
      </div>
      <div className="min-h-[40px] flex-1 overflow-auto bg-app-bg">
        <LinedPreview rendering={rendering} onFlip={onFlip} />
      </div>
      <div className="flex items-center gap-3 border-t border-border px-2 py-1 text-xs text-muted">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span><span className="text-foreground">⏎</span> kept</span>
          <span><span className="text-foreground">␣</span> space</span>
          <span><span className="text-foreground">⌁</span> joined</span>
          <span><span className="rounded-[2px] bg-success/15 px-0.5 text-foreground underline decoration-success decoration-dotted">abc</span> grown</span>
        </span>
        <span className="truncate"><Shortcut>{LEFT}{RIGHT}</Shortcut> end <Shortcut>{SHIFT}{LEFT}{RIGHT}</Shortcut> start</span>
        <span className="ml-auto shrink-0 whitespace-nowrap">{rendering.lines} {rendering.lines === 1 ? 'line' : 'lines'} · {rendering.chars} ch</span>
        <button type="button" onClick={onCopy} className="flex shrink-0 items-center gap-1 rounded bg-header-active-bg px-2 py-0.5 text-header-active-fg">
          {flashed ? <CheckIcon size={12} weight="bold" /> : <span className="opacity-70">[↵]</span>} Copy
        </button>
      </div>
    </div>
  );
}

/** Full width, on whichever side of the selection has more room. */
function placeEditor(sel: Span, width: number, height: number): CSSProperties {
  const gap = 6;
  const below = (sel.end.row + 1) * CELL_H + gap;
  const above = sel.start.row * CELL_H - gap;
  const roomBelow = height - below;
  const base: CSSProperties = { left: -4, width: width + 8 };
  return roomBelow >= above
    ? { ...base, top: below, maxHeight: Math.max(150, Math.min(320, roomBelow)) }
    : { ...base, bottom: height - above, maxHeight: Math.max(150, Math.min(320, above)) };
}

// ---------------------------------------------------------------------------
// Playground

type Host = 'claudeInline' | 'claudeFullscreen' | 'shell';
const HOSTS: { id: Host; label: string; screen: keyof typeof SCREENS2; mouseMode: boolean }[] = [
  { id: 'claudeInline', label: 'Claude Code, inline (Dormouse selects)', screen: 'claude', mouseMode: false },
  { id: 'claudeFullscreen', label: 'Claude Code, fullscreen (program owns the mouse)', screen: 'claude', mouseMode: true },
  { id: 'shell', label: 'zsh (true soft wraps)', screen: 'shell', mouseMode: false },
];

interface Preset {
  a: GridPos;
  b: GridPos;
  scopeIndex?: number;
  format?: FormatId;
  overrides?: Record<number, BreakKind>;
}

interface Props {
  host: Host;
  preset?: Preset;
}

type Phase = 'idle' | 'dragging' | 'armed' | 'open';

function CopyEditorPrototype({ host: initialHost, preset }: Props) {
  const [hostId, setHostId] = useState<Host>(initialHost);
  const host = HOSTS.find((h) => h.id === hostId)!;
  const screen = SCREENS2[host.screen];
  const { mouseMode } = host;

  const [anchor, setAnchor] = useState<GridPos | null>(null);
  const [sel, setSel] = useState<Span | null>(preset ? normalizeSpan(preset.a, preset.b) : null);
  const [phase, setPhase] = useState<Phase>(preset ? 'open' : 'idle');
  const [scopeIndex, setScopeIndex] = useState(preset?.scopeIndex ?? 0);
  const [format, setFormat] = useState<FormatId>(preset?.format ?? AUTO);
  const [overrides, setOverrides] = useState<Record<number, BreakKind>>(preset?.overrides ?? {});
  const [flashed, setFlashed] = useState(false);
  const [clipboard, setClipboard] = useState<string | null>(null);

  const scopes = useMemo(() => (sel ? computeScopes(screen, sel) : []), [screen, sel]);
  const scope = scopes[Math.min(scopeIndex, scopes.length - 1)];

  const reset = useCallback(() => {
    setScopeIndex(0);
    setFormat(AUTO);
    setOverrides({});
    setFlashed(false);
  }, []);

  const close = useCallback(() => {
    // A program keeps painting its own highlight; Dormouse just steps back.
    setPhase(mouseMode && sel ? 'armed' : 'idle');
    if (!mouseMode) setSel(null);
    reset();
  }, [mouseMode, sel, reset]);

  const copy = useCallback(() => {
    if (!sel || !scope) return;
    const text = render(screen, scope.span, sel, format, overrides).text;
    setClipboard(text);
    void navigator.clipboard?.writeText(text).catch(() => {});
    setFlashed(true);
    window.setTimeout(close, 700);
  }, [sel, scope, screen, format, overrides, close]);

  const cycleFormat = useCallback((dir: 1 | -1) => {
    setOverrides({});
    setFormat((f) => FORMATS2[(FORMATS2.findIndex((x) => x.id === f) + dir + FORMATS2.length) % FORMATS2.length].id);
  }, []);

  const onDrag = (dragPhase: 'down' | 'move' | 'up', pos: GridPos) => {
    if (dragPhase === 'down') {
      reset();
      setAnchor(pos);
      setSel(normalizeSpan(pos, pos));
      setPhase('dragging');
      return;
    }
    if (!anchor) return;
    const span = normalizeSpan(anchor, pos);
    setSel(span);
    if (dragPhase !== 'up') return;
    setAnchor(null);
    if (span.start.row === span.end.row && span.start.col === span.end.col) {
      setSel(null);
      setPhase('idle');
      return;
    }
    // Dormouse owns the drag: open on mouse-up. A program-owned drag waits for
    // the copy chord, which Dormouse sees before the program would.
    setPhase(mouseMode ? 'armed' : 'open');
  };

  useEffect(() => {
    const onKey = (ev: KeyboardEvent) => {
      if (!sel || phase === 'idle' || phase === 'dragging') return;
      const chord = (ev.metaKey || ev.ctrlKey) && ev.key.toLowerCase() === 'c';
      const handled = () => {
        ev.preventDefault();
        ev.stopPropagation();
      };
      if (ev.key === 'Escape') {
        handled();
        if (phase === 'armed') {
          setSel(null);
          setPhase('idle');
        } else close();
        return;
      }
      if (phase === 'armed') {
        if (chord) {
          handled();
          setPhase('open');
        }
        return;
      }
      if (chord || ev.key === 'Enter') { handled(); copy(); return; }
      if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
      const key = ev.key.toLowerCase();
      if (key === 'e') {
        handled();
        setOverrides({});
        setScopeIndex((i) => (ev.shiftKey ? Math.max(0, Math.min(i, scopes.length - 1) - 1) : Math.min(scopes.length - 1, i + 1)));
        return;
      }
      if (key === 'f') { handled(); cycleFormat(ev.shiftKey ? -1 : 1); return; }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        handled();
        const dir = ev.key === 'ArrowRight' ? 1 : -1;
        setOverrides({});
        setScopeIndex(0);
        setSel((s) => {
          if (!s) return s;
          const next = ev.shiftKey
            ? { start: nudge(screen, s.start, dir, 'start'), end: s.end }
            : { start: s.start, end: nudge(screen, s.end, dir, 'end') };
          const ordered = next.start.row < next.end.row || (next.start.row === next.end.row && next.start.col <= next.end.col);
          return ordered ? next : s;
        });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sel, phase, scopes.length, screen, close, copy, cycleFormat]);

  const outline = mouseMode ? (phase === 'open' ? sel : null) : (phase !== 'idle' ? sel : null);
  const programHighlight = mouseMode && phase !== 'idle' ? sel : null;
  const scopePreview = phase === 'open' && scope && scope.id !== 'selection' ? scope.span : null;

  const instructions = (() => {
    if (phase === 'idle') return mouseMode ? `Drag across the text (Claude Code paints its own highlight), then press ${COPY_CHORD}.` : 'Drag across the text.';
    if (phase === 'dragging') return 'Release to finish the selection.';
    if (phase === 'armed') return `Press ${COPY_CHORD}: Dormouse saw the drag and captured the same cells.`;
    return `e / ${SHIFT}e scope · f format · ${LEFT}${RIGHT} end · ${SHIFT}${LEFT}${RIGHT} start · click a mark to flip one break · ↵ or ${COPY_CHORD} copies · Esc closes`;
  })();

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-app-bg p-4 font-mono text-sm text-app-fg">
      <div className="flex flex-wrap items-center gap-2">
        <Segment value={hostId} onPick={(h) => { setHostId(h); setSel(null); setPhase('idle'); reset(); }} items={HOSTS.map((h) => ({ id: h.id, label: h.label }))} />
      </div>
      <div className="min-h-4 text-xs text-muted">{instructions}</div>
      <div className="flex items-start gap-4">
        <MockTerminal screen={screen} mouseMode={mouseMode} outline={outline} programHighlight={programHighlight} scopePreview={scopePreview} onDrag={onDrag}>
          {({ width, height, cellW }) => {
            if (!sel) return null;
            if (phase === 'armed') {
              const top = (sel.end.row + 1) * CELL_H + 4;
              const left = Math.max(0, Math.min(width - 300, sel.end.col * cellW));
              return <ArmedHint text={`Dormouse saw this drag · [${COPY_CHORD}] copy`} style={top + 24 > height ? { left, top: sel.start.row * CELL_H - 24 } : { left, top }} />;
            }
            if (phase !== 'open') return null;
            return (
              <div className="absolute z-20 flex flex-col" style={placeEditor(sel, width, height)}>
                <CopyEditor
                  screen={screen}
                  sel={sel}
                  scopeIndex={scopeIndex}
                  format={format}
                  overrides={overrides}
                  flashed={flashed}
                  onScope={(i) => { setScopeIndex(i); setOverrides({}); }}
                  onFormat={(f) => { setFormat(f); setOverrides({}); }}
                  onFlip={(i) => setOverrides((o) => {
                    const current = scope ? render(screen, scope.span, sel, format, o).breaks[i] : 'keep';
                    const next: BreakKind = current === 'keep' ? 'space' : current === 'space' ? 'none' : 'keep';
                    return { ...o, [i]: next };
                  })}
                  onCopy={copy}
                />
              </div>
            );
          }}
        </MockTerminal>
        <ClipboardPanel text={clipboard} />
      </div>
    </div>
  );
}

const meta: Meta<typeof CopyEditorPrototype> = {
  title: 'Prototypes/Copy editor 2',
  component: CopyEditorPrototype,
  parameters: { layout: 'fullscreen' },
  argTypes: { host: { control: 'inline-radio', options: HOSTS.map((h) => h.id) } },
};

export default meta;
type Story = StoryObj<typeof CopyEditorPrototype>;

const C = CLAUDE_OFFSET;
const S = SHELL_OFFSET;

/** Drag in the terminal; the host switch picks who owns the mouse. */
export const Playground: Story = {
  args: { host: 'claudeInline' },
};

/** A hard-wrapped paragraph, the drag ending mid-word: Auto joins each wrap
 *  with a space, so it lands as one line. */
export const Prose: Story = {
  args: { host: 'claudeInline', preset: { a: { row: C + 2, col: 25 }, b: { row: C + 5, col: 20 } } },
};

/** The same drag with `f` pressed once: Exact, every displayed break and
 *  indent, for checking what the terminal actually holds. */
export const ProseExact: Story = {
  args: { host: 'claudeInline', preset: { a: { row: C + 2, col: 25 }, b: { row: C + 5, col: 20 }, format: 'exact' } },
};

/** A URL the TUI split at the margin, its start missed, after one `e`: the
 *  scope grew to the full URL and Auto rejoined the split with no space. */
export const ClippedUrlGrown: Story = {
  args: { host: 'claudeInline', preset: { a: { row: C + 13, col: 44 }, b: { row: C + 14, col: 30 }, scopeIndex: 1 } },
};

/** Fullscreen Claude Code: it painted the highlight and owns the mouse;
 *  Dormouse shadowed the drag and opened on the copy chord. Prose joins, the
 *  code keeps its breaks and relative indent. */
export const FullscreenProseAndCode: Story = {
  args: { host: 'claudeFullscreen', preset: { a: { row: C + 7, col: 2 }, b: { row: C + 11, col: 44 } } },
};

/** One break flipped by hand (the dashed mark): Auto's first join kept as a
 *  line break, and the format reads `Auto*`. */
export const BreakFlipped: Story = {
  args: { host: 'claudeInline', preset: { a: { row: C + 2, col: 2 }, b: { row: C + 5, col: 27 }, overrides: { 1: 'keep' } } },
};

/** zsh: xterm knows which rows are true soft wraps, so Auto rejoins the token
 *  exactly where Spaces would break it. */
export const ShellSoftWrap: Story = {
  args: { host: 'shell', preset: { a: { row: S + 6, col: 0 }, b: { row: S + 8, col: 37 } } },
};

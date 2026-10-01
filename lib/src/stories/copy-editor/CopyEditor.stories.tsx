import { clsx } from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import type { Meta, StoryObj } from '@storybook/react';
import {
  ArmedHint,
  CELL_H,
  COPY_CHORD,
  ChooserPanel,
  ClipboardPanel,
  EditorPanel,
  MockTerminal,
  ReceiptPanel,
  buildOptions,
  type CopyOption,
} from './CopyMockups';
import {
  FORMATS,
  RECOMMENDED,
  SCREENS,
  computeScopes,
  normalizeSpan,
  nudge,
  render,
  type BreakKind,
  type FormatId,
  type GridPos,
  type ScreenId,
  type Span,
} from './model';

// Mockups for a copy editor that replaces the Copy Raw / Copy Rewrapped popup
// (docs/specs/mouse-and-clipboard.md §4). Nothing here is wired to the real
// selection store: the terminal is drawn by React so the TUI's own highlight,
// Dormouse's outline, and a candidate scope can be shown side by side.

type Concept = 'chooser' | 'receipt' | 'editor';
type Host = 'shell' | 'claudeInline' | 'claudeFullscreen';

const CONCEPTS: { id: Concept; label: string; pitch: string }[] = [
  { id: 'chooser', label: 'A · Numbered chooser', pitch: 'The brief: every option numbered, previewed, one key to copy. Nothing reaches the clipboard until you pick.' },
  { id: 'receipt', label: 'B · Copy, then switch', pitch: `${COPY_CHORD} copies ★ at once and shows exactly what you got; a digit swaps it while the receipt is up.` },
  { id: 'editor', label: 'C · Editor', pitch: 'Scope ladder, format presets, and a chip on every line break you can flip by hand; arrows nudge the edges.' },
];

const HOSTS: { id: Host; label: string; screen: ScreenId; mouseMode: boolean }[] = [
  { id: 'claudeInline', label: 'Claude Code, inline (Dormouse selects)', screen: 'claude', mouseMode: false },
  { id: 'claudeFullscreen', label: 'Claude Code, fullscreen (program owns the mouse)', screen: 'claude', mouseMode: true },
  { id: 'shell', label: 'zsh (true soft wraps)', screen: 'shell', mouseMode: false },
];

interface Preset {
  a: GridPos;
  b: GridPos;
  /** Chooser: which option starts focused. Receipt: which one was copied. */
  key?: string;
  /** Editor: starting scope index and break overrides. */
  scopeIndex?: number;
  overrides?: Record<number, BreakKind>;
}

interface Props {
  concept: Concept;
  host: Host;
  preset?: Preset;
  /** What the program itself offered over OSC 52 (fullscreen TUI only). */
  programCopy?: string;
}

type Phase = 'idle' | 'dragging' | 'armed' | 'open';

async function writeClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // The mock clipboard panel is the record either way.
  }
}

function CopyEditorPlayground(props: Props) {
  const [concept, setConcept] = useState<Concept>(props.concept);
  const [hostId, setHostId] = useState<Host>(props.host);
  const host = HOSTS.find((h) => h.id === hostId)!;
  const screen = SCREENS[host.screen];
  const { mouseMode } = host;
  const program = screen.program;

  const presetSpan = props.preset ? normalizeSpan(props.preset.a, props.preset.b) : null;
  const [anchor, setAnchor] = useState<GridPos | null>(null);
  const [sel, setSel] = useState<Span | null>(presetSpan);
  const [phase, setPhase] = useState<Phase>(presetSpan ? 'open' : 'idle');
  const [clipboard, setClipboard] = useState<string | null>(null);

  // Concept state.
  const [focused, setFocused] = useState(0);
  const [flashedKey, setFlashedKey] = useState<string | null>(null);
  const [copiedKey, setCopiedKey] = useState<string>(props.preset?.key ?? FORMATS.find((f) => f.id === RECOMMENDED)!.key);
  const [hoverScope, setHoverScope] = useState<number | null>(null);
  const [scopeIndex, setScopeIndex] = useState(props.preset?.scopeIndex ?? 0);
  const [format, setFormat] = useState<FormatId>(RECOMMENDED);
  const [overrides, setOverrides] = useState<Record<number, BreakKind>>(props.preset?.overrides ?? {});
  const [editorFlash, setEditorFlash] = useState(false);
  const [autoCopied, setAutoCopied] = useState(false);

  const options: CopyOption[] = useMemo(() => {
    if (!sel) return [];
    return buildOptions(screen, sel, mouseMode && props.programCopy ? { program, text: props.programCopy } : undefined);
  }, [screen, sel, mouseMode, props.programCopy, program]);

  const recommendedIndex = Math.max(0, options.findIndex((o) => o.recommended));

  const resetConcept = useCallback((keepCopied = false) => {
    setFocused(recommendedIndexFor(options));
    setFlashedKey(null);
    if (!keepCopied) setCopiedKey(FORMATS.find((f) => f.id === RECOMMENDED)!.key);
    setHoverScope(null);
    setScopeIndex(0);
    setFormat(RECOMMENDED);
    setOverrides({});
    setEditorFlash(false);
    setAutoCopied(false);
  }, [options]);

  // Preset stories open with focus on the requested option.
  const presetKey = props.preset?.key;
  useEffect(() => {
    if (!presetKey) {
      setFocused(recommendedIndex);
      return;
    }
    const i = options.findIndex((o) => o.key === presetKey);
    setFocused(i >= 0 ? i : recommendedIndex);
    // Only when the option list itself changes.
  }, [options, presetKey, recommendedIndex]);

  const close = useCallback(() => {
    // The program keeps painting its own highlight; Dormouse just steps back.
    setPhase(mouseMode && sel ? 'armed' : 'idle');
    if (!mouseMode) setSel(null);
    resetConcept();
  }, [mouseMode, sel, resetConcept]);

  const copy = useCallback((text: string) => {
    setClipboard(text);
    void writeClipboard(text);
  }, []);

  const pickChooser = useCallback((i: number) => {
    const o = options[i];
    if (!o) return;
    copy(o.rendering.text);
    setFocused(i);
    setFlashedKey(o.key);
    window.setTimeout(close, 700);
  }, [options, copy, close]);

  const pickReceipt = useCallback((i: number) => {
    const o = options[i];
    if (!o) return;
    copy(o.rendering.text);
    setCopiedKey(o.key);
    setPhase('open');
  }, [options, copy]);

  const editorScopes = useMemo(() => (sel ? computeScopes(screen, sel) : []), [screen, sel]);
  const editorCopy = useCallback(() => {
    if (!sel) return;
    const scope = editorScopes[Math.min(scopeIndex, editorScopes.length - 1)];
    copy(render(screen, scope.span, sel, format, overrides).text);
    setEditorFlash(true);
    window.setTimeout(close, 700);
  }, [sel, editorScopes, scopeIndex, screen, format, overrides, copy, close]);

  // Open, the way the copy chord (or mouse-up, when Dormouse owns the drag) would.
  const open = useCallback(() => {
    if (concept === 'receipt') {
      pickReceipt(recommendedIndex);
      return;
    }
    // When every format and scope agrees there is nothing to choose.
    if (options.length > 0 && options.every((o) => o.sameAs || o === options[0])) {
      copy(options[0].rendering.text);
      setAutoCopied(true);
      setPhase('armed');
      return;
    }
    setPhase('open');
  }, [concept, pickReceipt, recommendedIndex, options, copy]);

  const onDrag = (dragPhase: 'down' | 'move' | 'up', pos: GridPos) => {
    if (dragPhase === 'down') {
      resetConcept();
      setAnchor(pos);
      setSel(normalizeSpan(pos, pos));
      setPhase('dragging');
      return;
    }
    if (!anchor) return;
    const span = normalizeSpan(anchor, pos);
    setSel(span);
    if (dragPhase === 'up') {
      setAnchor(null);
      const moved = span.start.row !== span.end.row || span.start.col !== span.end.col;
      if (!moved) {
        setSel(null);
        setPhase('idle');
        return;
      }
      // Dormouse owns the drag: the chooser and editor open on mouse-up; the
      // receipt concept waits for the chord. A program-owned drag always waits.
      if (mouseMode || concept === 'receipt') setPhase('armed');
      else setPhase('open');
    }
  };

  // Keyboard, window-level like the real popup's listeners.
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
        if (phase === 'armed' && mouseMode) {
          setSel(null);
          setPhase('idle');
        } else close();
        return;
      }
      if (phase === 'armed') {
        if (chord) {
          handled();
          open();
        } else if (!mouseMode && concept === 'receipt' && /^[1-9]$/.test(ev.key)) {
          handled();
          pickReceipt(Number(ev.key) - 1);
        }
        return;
      }
      // phase === 'open'
      const digit = /^[1-9]$/.test(ev.key) ? Number(ev.key) - 1 : null;
      if (concept === 'chooser') {
        if (digit !== null) { handled(); pickChooser(digit); return; }
        if (chord || ev.key === 'Enter') { handled(); pickChooser(focused); return; }
        if (ev.key === 'ArrowDown') { handled(); setFocused((f) => Math.min(options.length - 1, f + 1)); return; }
        if (ev.key === 'ArrowUp') { handled(); setFocused((f) => Math.max(0, f - 1)); return; }
        if (ev.key === 'e') {
          handled();
          const next = options.findIndex((o, i) => i > focused && o.scope.id !== 'selection');
          const first = options.findIndex((o) => o.scope.id !== 'selection');
          if (next >= 0 || first >= 0) setFocused(next >= 0 ? next : first);
          return;
        }
      }
      if (concept === 'receipt') {
        if (digit !== null) { handled(); pickReceipt(digit); return; }
        if (chord) {
          // The chord again cycles to the next distinct text.
          handled();
          const at = options.findIndex((o) => o.key === copiedKey);
          for (let k = 1; k <= options.length; k++) {
            const o = options[(at + k) % options.length];
            if (!o.sameAs) { pickReceipt(options.indexOf(o)); break; }
          }
          return;
        }
        if (!['Shift', 'Meta', 'Control', 'Alt'].includes(ev.key)) close();
        return;
      }
      if (concept === 'editor') {
        if (digit !== null && digit < FORMATS.length) { handled(); setFormat(FORMATS[digit].id); setOverrides({}); return; }
        if (chord || ev.key === 'Enter') { handled(); editorCopy(); return; }
        if (ev.key === 'e' || ev.key === 'E') {
          handled();
          setOverrides({});
          setScopeIndex((i) => (ev.shiftKey ? Math.max(0, i - 1) : Math.min(editorScopes.length - 1, i + 1)));
          return;
        }
      }
      if (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight') {
        handled();
        const dir = ev.key === 'ArrowRight' ? 1 : -1;
        setOverrides({});
        setSel((s) => {
          if (!s) return s;
          const next = ev.shiftKey
            ? { start: nudge(screen, s.start, dir, 'start'), end: s.end }
            : { start: s.start, end: nudge(screen, s.end, dir, 'end') };
          return next.start.row < next.end.row || (next.start.row === next.end.row && next.start.col <= next.end.col) ? next : s;
        });
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [sel, phase, mouseMode, concept, options, focused, copiedKey, close, open, pickChooser, pickReceipt, editorCopy, editorScopes, screen]);

  // --- what the terminal shows -------------------------------------------
  const showOutline = !mouseMode ? (phase !== 'idle') : phase === 'open';
  const outline = showOutline ? sel : null;
  const programHighlight = mouseMode && phase !== 'idle' ? sel : null;
  let scopePreview: Span | null = null;
  if (phase === 'open' && sel) {
    if (concept === 'chooser') {
      const o = options[focused];
      if (o && o.scope.id !== 'selection') scopePreview = o.scope.span;
    } else if (concept === 'receipt') {
      const o = hoverScope !== null ? options[hoverScope] : options.find((x) => x.key === copiedKey);
      if (o && o.scope.id !== 'selection') scopePreview = o.scope.span;
    } else {
      const s = editorScopes[Math.min(scopeIndex, editorScopes.length - 1)];
      if (s && s.id !== 'selection') scopePreview = s.span;
    }
  }

  const panelRef = useRef<HTMLDivElement>(null);
  const [panelH, setPanelH] = useState(0);
  useLayoutEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setPanelH(el.getBoundingClientRect().height));
    ro.observe(el);
    setPanelH(el.getBoundingClientRect().height);
    return () => ro.disconnect();
  });

  const instructions = (() => {
    if (phase === 'idle') return mouseMode
      ? `Drag across the text (${program} paints its own highlight), then press ${COPY_CHORD}.`
      : 'Drag across the text.';
    if (phase === 'dragging') return 'Release to finish the selection.';
    if (phase === 'armed') {
      if (autoCopied) return 'Every format gives the same text, so it was copied directly.';
      return mouseMode ? `Press ${COPY_CHORD}: Dormouse saw the drag and captured the same cells.` : `Press ${COPY_CHORD} to copy ★, or a digit for another format.`;
    }
    if (concept === 'receipt') return `Digits swap what was copied; ${COPY_CHORD} again cycles; any other key dismisses (and would reach the program).`;
    if (concept === 'editor') return 'Digits pick a format, e / Shift+E change scope, ←→ nudge the edges, click a break chip to flip it.';
    return 'Digits copy directly; ↑↓ preview; e jumps to the grow options; ←→ / Shift+←→ nudge the edges.';
  })();

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-app-bg p-4 font-mono text-sm text-app-fg">
      <div className="flex flex-wrap items-center gap-2">
        <Segmented
          value={concept}
          onChange={(c) => {
            setConcept(c);
            resetConcept();
            if (sel && phase !== 'idle') setPhase(mouseMode || c === 'receipt' ? 'armed' : 'open');
          }}
          items={CONCEPTS.map((c) => ({ id: c.id, label: c.label }))}
        />
        <Segmented value={hostId} onChange={(h) => { setHostId(h); setSel(null); setPhase('idle'); resetConcept(); }} items={HOSTS.map((h) => ({ id: h.id, label: h.label }))} />
      </div>
      <div className="min-h-8 max-w-[900px] text-xs text-muted">
        <span className="text-foreground">{CONCEPTS.find((c) => c.id === concept)!.pitch}</span> {instructions}
      </div>
      <div className="flex items-start gap-4">
        <MockTerminal
          screen={screen}
          mouseMode={mouseMode}
          outline={outline}
          programHighlight={programHighlight}
          scopePreview={scopePreview}
          onDrag={onDrag}
        >
          {({ cellW, width, height }) => {
            if (!sel) return null;
            const style = placePanel(sel, cellW, width, height, panelH, concept === 'editor' ? 570 : concept === 'chooser' ? 560 : 500);
            if (phase === 'armed') {
              const text = autoCopied
                ? '✓ Copied — every format gives the same text'
                : mouseMode
                  ? `Dormouse saw this drag · [${COPY_CHORD}] copy options`
                  : `[${COPY_CHORD}] copy ★ Rewrapped · [1–5] other formats`;
              return <ArmedHint text={text} style={placeHint(sel, cellW, width, height)} />;
            }
            if (phase !== 'open') return null;
            return (
              <div ref={panelRef} className="absolute z-20" style={style}>
                {concept === 'chooser' && (
                  <ChooserPanel
                    options={options}
                    focused={Math.min(focused, options.length - 1)}
                    flashedKey={flashedKey}
                    onFocus={setFocused}
                    onPick={pickChooser}
                    source={mouseMode ? `from ${program}'s selection` : 'selection'}
                  />
                )}
                {concept === 'receipt' && (
                  <ReceiptPanel options={options} copiedKey={copiedKey} onPick={pickReceipt} onFocusScope={setHoverScope} />
                )}
                {concept === 'editor' && (
                  <EditorPanel
                    screen={screen}
                    sel={sel}
                    scopeIndex={scopeIndex}
                    format={format}
                    overrides={overrides}
                    flashed={editorFlash}
                    onScope={(i) => { setScopeIndex(i); setOverrides({}); }}
                    onFormat={(f) => { setFormat(f); setOverrides({}); }}
                    onToggleBreak={(i) => setOverrides((o) => {
                      const scope = editorScopes[Math.min(scopeIndex, editorScopes.length - 1)];
                      const current = render(screen, scope.span, sel, format, o).breaks[i];
                      const next: BreakKind = current === 'keep' ? 'space' : current === 'space' ? 'none' : 'keep';
                      return { ...o, [i]: next };
                    })}
                    onCopy={editorCopy}
                  />
                )}
              </div>
            );
          }}
        </MockTerminal>
        <ClipboardPanel text={clipboard} />
      </div>
    </div>
  );
}

function recommendedIndexFor(options: CopyOption[]): number {
  return Math.max(0, options.findIndex((o) => o.recommended));
}

/** Below the selection when it fits, else above, else whichever side is roomier. */
function placePanel(sel: Span, cellW: number, width: number, height: number, panelH: number, panelW: number): CSSProperties {
  const gap = 6;
  const below = (sel.end.row + 1) * CELL_H + gap;
  const above = sel.start.row * CELL_H - gap;
  const roomBelow = height - below;
  const left = Math.max(-8, Math.min(width - panelW + 8, sel.end.col * cellW - 48));
  // Never cover the selection: when neither side fits, overflow the pane
  // downward (a real build would need a pane-external surface here).
  if (panelH <= roomBelow || panelH > above) return { left, top: below };
  return { left, top: above - panelH };
}

function placeHint(sel: Span, cellW: number, width: number, height: number): CSSProperties {
  const top = (sel.end.row + 1) * CELL_H + 4;
  const left = Math.max(0, Math.min(width - 340, sel.end.col * cellW));
  return top + 24 > height ? { left, top: sel.start.row * CELL_H - 24 } : { left, top };
}

function Segmented<T extends string>({ value, onChange, items }: { value: T; onChange: (v: T) => void; items: { id: T; label: string }[] }) {
  return (
    <div className="flex overflow-hidden rounded border border-border text-xs">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          onClick={() => onChange(it.id)}
          className={clsx('border-r border-border px-2 py-1 last:border-r-0', it.id === value ? 'bg-header-active-bg text-header-active-fg' : 'hover:bg-foreground/10')}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

const meta: Meta<typeof CopyEditorPlayground> = {
  title: 'Prototypes/Copy editor',
  component: CopyEditorPlayground,
  parameters: { layout: 'fullscreen' },
  argTypes: {
    concept: { control: 'inline-radio', options: CONCEPTS.map((c) => c.id) },
    host: { control: 'inline-radio', options: HOSTS.map((h) => h.id) },
  },
};

export default meta;
type Story = StoryObj<typeof CopyEditorPlayground>;

/** Drag in the terminal; switch concepts and hosts from the toolbar. */
export const Playground: Story = {
  args: { concept: 'chooser', host: 'claudeInline' },
};

/** A: a hard-wrapped paragraph, the drag ending mid-word. ★ Rewrapped joins
 *  the rows; "Whole words" grows the clipped end. */
export const ChooserProse: Story = {
  args: { concept: 'chooser', host: 'claudeInline', preset: { a: { row: 2, col: 25 }, b: { row: 5, col: 20 } } },
};

/** A: a URL the TUI hard-wrapped at the margin, with its start missed. Focus
 *  is on "Full URL": the dashed scope shows what it adds, and the preview marks
 *  the added characters and the rejoined split. */
export const ChooserClippedUrl: Story = {
  args: { concept: 'chooser', host: 'claudeInline', preset: { a: { row: 13, col: 44 }, b: { row: 14, col: 30 }, key: '6' } },
};

/** A, fullscreen TUI: the program painted the highlight and owns the mouse;
 *  Dormouse shadowed the drag and opens on the copy chord. The last row is the
 *  program's own OSC 52 text, offered instead of silently dropped. */
export const ChooserFullscreenTui: Story = {
  args: {
    concept: 'chooser',
    host: 'claudeFullscreen',
    preset: { a: { row: 16, col: 2 }, b: { row: 17, col: 43 } },
    programCopy: 'To verify locally, run `pnpm --filter dormouse-lib exec vitest run src/lib/selection-text.test.ts --repeat 50`',
  },
};

/** A, plain shell: xterm knows which rows are true soft wraps, so Rewrapped
 *  rejoins the token exactly while Spaces breaks it. */
export const ChooserShellSoftWrap: Story = {
  args: { concept: 'chooser', host: 'shell', preset: { a: { row: 6, col: 0 }, b: { row: 8, col: 37 } } },
};

/** B: the copy chord already put ★ on the clipboard; the receipt shows what
 *  landed and offers the others. A code block, so Rewrapped kept the breaks. */
export const ReceiptCodeBlock: Story = {
  args: { concept: 'receipt', host: 'claudeFullscreen', preset: { a: { row: 9, col: 0 }, b: { row: 11, col: 44 } } },
};

/** C: a drag inside one paragraph, grown to the whole reply, with one break
 *  flipped by hand (the dashed chip). */
export const EditorBreakChips: Story = {
  args: { concept: 'editor', host: 'claudeInline', preset: { a: { row: 3, col: 10 }, b: { row: 4, col: 40 }, scopeIndex: 3, overrides: { 1: 'keep' } } },
};

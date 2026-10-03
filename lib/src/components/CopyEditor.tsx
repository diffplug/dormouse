import { clsx } from 'clsx';
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type ReactNode, type Ref } from 'react';
import { CheckIcon } from '@phosphor-icons/react';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  getMouseSelectionSnapshot,
  setSelection,
  subscribeToMouseSelection,
  subscribeToRenderTick,
  type CopyEditorState,
  type CopyOutcome,
  type Selection,
} from '../lib/mouse-selection';
import { spanOfSelection, type BreakKind, type EditorFormat, type Piece, type Rendering, type Span } from '../lib/copy-text';
import { duplicateFormats, editorFormats, editorRendering, flipCopyBreak, formatRenderings, isEdited, setCopyFormat, setCopyScope, type FormatRenderings } from '../lib/copy-editor';
import { placeCopyEditor, selectionBand, type CopyEditorSide } from '../lib/copy-editor-placement';
import { copySelection } from '../lib/copy-selection';
import { setPortalAnchor } from '../lib/dom';
import { getTerminalOverlayDims } from '../lib/terminal-registry';
import { getRunningCommandWatchKey } from '../lib/terminal-state-store';
import { overlayViewportBounds, subscribeOverlayViewport } from '../lib/ui-geometry';
import { COPY_CHORD_LABEL } from './wall/keyboard/chords';
import { COPY_EDITOR_Z_INDEX, COPY_EXPANDED_TEXT_CLASS, COPY_OUTCOME_LABEL, modalActionButton, modalSurface, popupButton, portalToBody, Shortcut } from './design';
import { createHeightMeasurer, measureNaturalWidth, measureWidth, type CopyEditorParts } from './copy-editor-measure';
import { createRectMotion, type RectMotion } from './rect-motion';
import { TouchUiContext } from './touch-ui-context';
import { workspaceInTravel } from './workspace-motion';
import { subscribePaneMotion } from './wall/pane-motion';
import { LayoutFramesContext, WorkspaceActiveContext, WorkspaceIdContext, ZoomedIdContext } from './wall/wall-context';

/** Shift, and the arrow keys, as the mobile compass rose writes them
 *  (`lib/src/lib/mobile-gesture-menu.ts`). */
const SHIFT = '⬆︎';
const LEFT = '◀';
const RIGHT = '▶';

const FORMAT_NAMES: Record<Exclude<EditorFormat, 'program'>, string> = {
  auto: 'Auto',
  exact: 'Exact',
  spaces: 'Spaces',
  joined: 'No breaks',
};

const FORMAT_BLURBS: Record<EditorFormat, string> = {
  auto: 'each line break judged on its own',
  exact: 'as displayed',
  spaces: 'every line break becomes one space',
  joined: 'every line break deleted',
  program: 'the text the program itself copied',
};

/** The running program, wrappers and earlier commands skipped, for its own
 *  copy's label (spec §4.6). */
const programName = (terminalId: string) => getRunningCommandWatchKey(terminalId) ?? 'program';

const MARK_GLYPH: Record<BreakKind, string> = { keep: '⏎', space: '␣', none: '⌁' };
const MARK_TITLE: Record<BreakKind, string> = {
  keep: 'Line break kept',
  space: 'Line break became one space',
  none: 'Line break deleted, joining the two sides',
};

/** The lines of each format the width probe lays out. */
const PROBE_LINES = 3;
/** Under any monospace cell the editor's type renders, so a probed line cut to
 *  a window's width in these still fills it. */
const PROBE_MIN_CELL_PX = 4;
const PROBE_MARGIN_CELLS = 8;

/** On touch, the root's margin around the visible editor
 *  (docs/specs/mouse-and-clipboard.rationale.md -> "4.5 Placement and Dismissal"). */
export const TOUCH_SLOP_PX = 16;

/** Geometry and, after mounting, visibility are the motion driver's alone:
 *  React sets neither, so a render never undoes a frame. */
const ROOT_STYLE: CSSProperties = { position: 'fixed', zIndex: COPY_EDITOR_Z_INDEX, visibility: 'hidden' };
const SURFACE_STYLE: CSSProperties = { contain: 'layout paint' };

/** A stable gutter: a classic scrollbar appearing never narrows the lines. */
const PREVIEW_CLASS = 'min-h-10 flex-1 overflow-auto bg-app-bg [scrollbar-gutter:stable]';
const PREVIEW_LINES_CLASS = 'py-1 font-mono text-sm leading-[18px] text-foreground';

/**
 * The copy editor over a finalized selection (docs/specs/mouse-and-clipboard.md
 * §4): the text a copy would produce, with a mark on every line break it
 * crossed, placed anywhere in the window (§4.5). Keys are handled by the Wall
 * (`handle-mouse-selection-keys.ts`); this owns the pointer.
 */
export function CopyEditor({ terminalId }: { terminalId: string }) {
  const states = useSyncExternalStore(subscribeToMouseSelection, getMouseSelectionSnapshot);
  // A hidden Workspace consumes no window input (docs/specs/layout.md →
  // "Workspaces"); the selection stays in the store for the way back.
  const workspaceActive = useContext(WorkspaceActiveContext);
  const { selection, copyEditor, copyOutcome, programCopy } = states.get(terminalId) ?? DEFAULT_MOUSE_SELECTION_STATE;
  if (!workspaceActive || !copyEditor || !selection) return null;
  return <OpenCopyEditor terminalId={terminalId} selection={selection} editor={copyEditor} copyState={copyOutcome ?? 'idle'} programCopy={programCopy} />;
}

/** What placement reads, as last rendered and measured. */
interface Inputs {
  selection: Selection;
  scope: Span;
  touch: boolean;
  zoomedId: string | null;
  workspaceId: string | null;
  /** The longest line across every format of the scope. */
  naturalWidth: number;
  /** The header and footer whole, as wide as any format shows them. */
  chromeWidth: number;
  /** Their segments, count, and Copy whole, the key hints and legend left out. */
  essentialWidth: number;
  heightAt: (width: number) => number;
  /** Everything the last placement read, so a tick that moved nothing skips
   *  it; null while hidden. */
  placed: readonly unknown[] | null;
}

/** True while the pane is out of sight, which the editor on `document.body`
 *  does not inherit, cheapest check first: another pane zoomed over it, which
 *  a terminal context floats above; its Wall in Workspace travel, a
 *  presentation the editor does not follow; or the pane hidden, as a parked
 *  leaf or a Tool's other face hides it. */
function concealed(anchor: Element, { zoomedId, workspaceId }: Inputs): boolean {
  if (zoomedId !== null
    && anchor.closest('[data-lath-leaf]')?.getAttribute('data-lath-leaf') !== zoomedId
    && !anchor.closest('[data-terminal-context]')) return true;
  if (workspaceId !== null && workspaceInTravel(workspaceId)) return true;
  return getComputedStyle(anchor).visibility === 'hidden';
}

const noFlip = () => {};
const noHeight = () => 0;
const sameKey = (a: readonly unknown[], b: readonly unknown[]) => a.every((v, n) => v === b[n]);

/** Mounted while the editor is open, so closing drops its motion and side. */
const OpenCopyEditor = memo(function OpenCopyEditor({ terminalId, selection, editor, copyState, programCopy }: {
  terminalId: string;
  selection: Selection;
  editor: CopyEditorState;
  copyState: CopyState;
  programCopy: string | null;
}) {
  const touchUi = useContext(TouchUiContext);
  const zoomedId = useContext(ZoomedIdContext);
  const workspaceId = useContext(WorkspaceIdContext);
  const subscribeLayoutFrames = useContext(LayoutFramesContext);
  const scope = editor.scopes[editor.scope].span;

  // Each scope's formats are rendered once and cached on it (`copy-editor.ts`),
  // so `f`, the duplicate check, the width probe, and the copy all reuse them.
  // They read only the scope's buffer and span, so a flipped mark keeps them.
  const rendering = useMemo(() => editorRendering(editor, programCopy), [editor, programCopy]);
  const renderings = useMemo(() => formatRenderings(editor, programCopy), [editor.buffer, scope, programCopy]);
  const sameAs = useMemo(() => duplicateFormats(renderings), [renderings]);
  const onFlip = useCallback((index: number, kind: BreakKind) => flipCopyBreak(terminalId, index, kind), [terminalId]);
  const most = useMemo(() => mostCounted(renderings), [renderings]);

  const edited = isEdited(editor);
  const lines = lineCount(rendering.text);
  const fromProgram = editor.format === 'program';
  const expanded = editor.scope > 0;
  const nudgeable = selection.shape !== 'block';
  const formats = editorFormats(programCopy);
  const program = programCopy === null ? null : programName(terminalId);
  const formatName = (f: EditorFormat) => (f === 'program' ? `From ${program}` : FORMAT_NAMES[f]);
  // The widest count any format, or a flipped mark past them, gives.
  const widestCount = `${Math.max(most.lines, lines)} lines · ${Math.max(most.ch, rendering.text.length)} ch`;

  const anchorRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const surfaceRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const widthProbeRef = useRef<HTMLDivElement>(null);
  const chromeProbeRef = useRef<HTMLDivElement>(null);
  const heightProbeRef = useRef<HTMLDivElement>(null);
  const inputs = useRef<Inputs>({ selection, scope, touch: touchUi, zoomedId, workspaceId, naturalWidth: 0, chromeWidth: 0, essentialWidth: 0, heightAt: noHeight, placed: null });
  const motionRef = useRef<RectMotion | null>(null);
  motionRef.current ??= createRectMotion({
    // `r` is the visible editor; on touch the root pads it with the slop.
    write: (r) => {
      const slop = inputs.current.touch ? TOUCH_SLOP_PX : 0;
      const style = rootRef.current!.style;
      style.padding = `${slop}px`;
      style.left = `${r.left - slop}px`;
      style.top = `${r.top - slop}px`;
      style.width = `${r.width + 2 * slop}px`;
      style.height = `${r.height + 2 * slop}px`;
    },
    show: (visible) => rootRef.current?.style.setProperty('visibility', visible ? 'visible' : 'hidden'),
  });
  const motion = motionRef.current;

  const parts = (): CopyEditorParts => ({
    surface: surfaceRef.current!,
    header: headerRef.current!,
    preview: previewRef.current!,
    footer: footerRef.current!,
    widthProbe: widthProbeRef.current!,
    heightProbe: heightProbeRef.current!,
  });

  /** Hide the editor and forget its side, so the next placement starts fresh. */
  const conceal = useCallback(() => {
    const root = rootRef.current;
    if (!root || root.dataset.copyEditorSide === undefined) return;
    motion.hide();
    delete root.dataset.copyEditorSide;
    inputs.current.placed = null;
  }, [motion]);

  /** Place the editor against the selection and pane as they are now. */
  const recompute = useCallback(() => {
    const root = rootRef.current;
    const anchor = anchorRef.current;
    if (!root || !anchor) return;
    const at = inputs.current;
    const dims = concealed(anchor, at) ? null : getTerminalOverlayDims(terminalId);
    if (!dims || dims.rows === 0 || dims.elementWidth === 0) {
      conceal();
      return;
    }
    const viewport = overlayViewportBounds();
    const key = [
      at.selection, at.scope, at.touch, at.naturalWidth, at.chromeWidth, at.essentialWidth, at.heightAt,
      dims.viewportY, dims.rows, dims.cellHeight, dims.gridTop, dims.elementLeft, dims.elementTop, dims.elementWidth, dims.elementHeight,
      viewport.left, viewport.top, viewport.right, viewport.bottom,
    ];
    if (at.placed && sameKey(at.placed, key)) return;
    at.placed = key;
    const { side, rect } = placeCopyEditor({
      viewport,
      pane: { left: dims.elementLeft, top: dims.elementTop, width: dims.elementWidth, height: dims.elementHeight },
      band: selectionBand(dims, [spanOfSelection(at.selection), at.scope]),
      naturalWidth: at.naturalWidth,
      chromeWidth: at.chromeWidth,
      essentialWidth: at.essentialWidth,
      naturalHeight: at.heightAt,
      touch: at.touch,
      previous: (root.dataset.copyEditorSide as CopyEditorSide | undefined) ?? null,
    });
    root.dataset.copyEditorSide = side;
    motion.setTarget(rect);
  }, [terminalId, motion, conceal]);

  useLayoutEffect(() => {
    const unmap = setPortalAnchor(rootRef.current!, anchorRef.current!);
    return () => {
      conceal();
      unmap();
    };
  }, [conceal]);

  // The width shows every format's longest line whole, so `f` and a flipped
  // mark never change it; a scope, a nudge, or an offer may.
  useLayoutEffect(() => {
    inputs.current.naturalWidth = measureNaturalWidth(parts());
  }, [renderings]);

  // The chrome probe reads only these, none of them the format: `f` never
  // re-measures it, and a flipped mark only past every format's count. Whole,
  // then with its key hints and legend hidden, which is all a side needs.
  const chromeDeps = [editor.scopes, expanded, program, touchUi, nudgeable, widestCount];
  useLayoutEffect(() => {
    const surface = surfaceRef.current!;
    const probe = chromeProbeRef.current!;
    inputs.current.chromeWidth = measureWidth(surface, probe);
    probe.setAttribute('data-essential', '');
    inputs.current.essentialWidth = measureWidth(surface, probe);
    probe.removeAttribute('data-essential');
  }, chromeDeps);

  useLayoutEffect(() => {
    inputs.current.heightAt = createHeightMeasurer(parts());
  }, [rendering]);

  // Before paint, so opening lands placed with no travel, and every selection,
  // scope, or text change re-places it at once.
  useLayoutEffect(() => {
    Object.assign(inputs.current, { selection, scope, touch: touchUi, zoomedId, workspaceId });
    recompute();
  }, [selection, scope, rendering, touchUi, zoomedId, workspaceId, recompute]);

  // Anything else that moves the pane or the band, coalesced to one placement
  // a frame: output and scrolling, the pane's own motion, the window. And a
  // press anywhere outside the editor dismisses it.
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    let frame: number | null = null;
    const schedule = () => {
      frame ??= requestAnimationFrame(() => {
        frame = null;
        recompute();
      });
    };
    const unsubscribes = [
      subscribeToRenderTick(schedule),
      subscribePaneMotion(anchorRef.current?.parentElement, schedule, subscribeLayoutFrames),
      subscribeOverlayViewport(schedule),
      () => { if (frame !== null) cancelAnimationFrame(frame); },
    ];
    for (const unsubscribe of unsubscribes) signal.addEventListener('abort', unsubscribe);
    window.addEventListener('mousedown', (ev) => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest(`[data-copy-editor-for="${terminalId}"]`)) setSelection(terminalId, null);
    }, { capture: true, signal });
    return () => controller.abort();
  }, [recompute, subscribeLayoutFrames, terminalId]);

  /** A key hint, which touch never shows. */
  const hint = (node: ReactNode) => (touchUi
    ? null
    : <span data-chrome-optional="" className="min-w-0 overflow-hidden whitespace-nowrap text-xs text-muted">{node}</span>);

  // The header and footer never wrap. The chrome probe lays them out as wide
  // as any format shows them: a `*` on one format, the widest count, and the
  // Copy button, whose labels are stacked to its widest. In a window or side
  // narrower than that, the key hints and the legend (`data-chrome-optional`)
  // clip first, so the segments, the count, and Copy still show.
  const header = (ref: Ref<HTMLDivElement> | undefined, starred: EditorFormat | null) => (
    <div ref={ref} className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
      {/* The program's own copy has no scope of Dormouse's to expand. */}
      <div className={clsx('flex min-w-0 items-center gap-2', fromProgram && 'pointer-events-none opacity-50')}>
        <Segment
          value={editor.scope}
          onPick={(i) => setCopyScope(terminalId, i)}
          items={editor.scopes.map((s, i) => ({ id: i, label: s.label }))}
        />
        {editor.scopes.length > 1 && hint(<><Shortcut>e</Shortcut> expand <Shortcut>{SHIFT}e</Shortcut> shrink</>)}
      </div>
      <div className="flex min-w-0 items-center gap-2">
        <Segment
          value={editor.format}
          onPick={(f) => setCopyFormat(terminalId, f)}
          items={formats.map((f) => ({
            id: f,
            label: `${formatName(f)}${f === starred ? '*' : ''}`,
            dim: !!sameAs[f],
            title: sameAs[f] ? `${FORMAT_BLURBS[f]}: same text as ${formatName(sameAs[f]!)}` : FORMAT_BLURBS[f],
          }))}
        />
        {hint(<><Shortcut>f</Shortcut> <Shortcut>{SHIFT}f</Shortcut></>)}
      </div>
    </div>
  );
  // On touch, Copy is a full-width row of its own, a thumb's height.
  const footer = (ref: Ref<HTMLDivElement> | undefined, count: string, state: CopyState) => {
    const copy = (
      <button
        type="button"
        tabIndex={-1}
        aria-label={COPY_LABEL[state]}
        data-copy-state={state}
        onClick={() => void copySelection(terminalId, { touch: touchUi })}
        className={modalActionButton({ tone: 'primary', class: touchUi ? 'h-11 w-full shrink-0 text-sm' : 'shrink-0 py-0.5' })}
      >
        <CopyLabel state={state} iconSize={touchUi ? 16 : 12} />
      </button>
    );
    return (
      <div ref={ref} className={clsx('flex shrink-0 flex-col gap-1.5 border-t border-border px-2 py-1 text-xs text-muted', touchUi && 'pb-2')}>
        <div className="flex min-w-0 items-center gap-3">
          <span data-chrome-optional="" className="flex min-w-0 items-center gap-2 overflow-hidden whitespace-nowrap">
            <span><span className="text-foreground">{MARK_GLYPH.keep}</span> kept</span>
            <span><span className="text-foreground">{MARK_GLYPH.space}</span> space</span>
            <span><span className="text-foreground">{MARK_GLYPH.none}</span> joined</span>
            {expanded && <span><span className={clsx(COPY_EXPANDED_TEXT_CLASS, 'px-0.5 text-foreground')}>abc</span> expanded</span>}
          </span>
          {nudgeable && hint(<><Shortcut>{LEFT}{RIGHT}</Shortcut> end <Shortcut>{SHIFT}{LEFT}{RIGHT}</Shortcut> start</>)}
          <span className="ml-auto shrink-0 whitespace-nowrap">{count}</span>
          {hint(<Shortcut>{COPY_CHORD_LABEL}</Shortcut>)}
          {!touchUi && copy}
        </div>
        {touchUi && copy}
      </div>
    );
  };

  // Rendered again only when what it measures, or the format, changes.
  const chromeProbe = useMemo(() => (
    <div
      ref={chromeProbeRef}
      data-chrome-probe=""
      aria-hidden
      inert
      className="invisible absolute left-0 top-0 flex w-max flex-col [&[data-essential]_[data-chrome-optional]]:hidden"
    >
      {header(undefined, formats[0])}
      {footer(undefined, widestCount, 'idle')}
    </div>
  ), [...chromeDeps, editor.format]);

  // On touch the root pads the visible surface with a `TOUCH_SLOP_PX` margin:
  // a press that just misses lands on the editor itself, so the
  // handlers below and the outside-press check make it inert, and no control
  // sits under it. `touch-manipulation` keeps a quick second tap a tap, never
  // a double-tap zoom.
  const root = (
    <div
      ref={rootRef}
      data-copy-editor-for={terminalId}
      style={ROOT_STYLE}
      className="touch-manipulation"
      // Portaled, its React events still bubble to the pane: keep its presses
      // from focusing the pane and its right-click from opening the terminal
      // context. It never takes focus, so keys stay with the pane (§4.5), but
      // a press on an actual preview scrollbar keeps its drag.
      onMouseDown={(e) => {
        e.stopPropagation();
        const preview = previewRef.current;
        const onScrollbar = e.target === preview && preview !== null && (
          (preview.scrollHeight > preview.clientHeight && e.nativeEvent.offsetX >= preview.clientWidth)
          || (preview.scrollWidth > preview.clientWidth && e.nativeEvent.offsetY >= preview.clientHeight)
        );
        if (!onScrollbar) e.preventDefault();
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div
        ref={surfaceRef}
        data-copy-editor-surface=""
        style={SURFACE_STYLE}
        className={modalSurface({ padding: 'none', elevation: 'modal', class: 'flex h-full w-full flex-col overflow-hidden border-foreground/20 text-sm' })}
      >
        {header(headerRef, edited ? editor.format : null)}
        <div ref={previewRef} className={PREVIEW_CLASS}>
          <LinedPreview rendering={rendering} onFlip={onFlip} />
        </div>
        {footer(footerRef, `${lines} ${lines === 1 ? 'line' : 'lines'} · ${rendering.text.length} ch`, copyState)}
        <div ref={widthProbeRef} aria-hidden inert className="invisible absolute left-0 top-0 w-max">
          <WidthProbe renderings={renderings} />
        </div>
        {chromeProbe}
        <div ref={heightProbeRef} aria-hidden inert className={clsx(PREVIEW_CLASS, 'invisible absolute left-0 top-0')}>
          <LinedPreview rendering={rendering} onFlip={noFlip} />
        </div>
      </div>
    </div>
  );

  // In `document.body`, free of the pane's clipping and of any Workspace's
  // stacking context; the anchor keeps its presses inside the pane for DOM
  // containment checks (`anchoredTarget`).
  return (
    <>
      <span ref={anchorRef} hidden data-copy-editor-anchor="" />
      {portalToBody(root)}
    </>
  );
});

/** What a copy did, as the Copy button shows it. */
type CopyState = 'idle' | CopyOutcome;
const COPY_LABEL: Record<CopyState, string> = { idle: 'Copy', ...COPY_OUTCOME_LABEL };

/** Every state's label stacked in one grid cell, only `state`'s shown, so the
 *  button is as wide as its widest and never shifts as a copy lands. */
function CopyLabel({ state, iconSize }: { state: CopyState; iconSize: number }) {
  return (
    <span className="grid justify-items-center">
      {(Object.entries(COPY_LABEL) as [CopyState, string][]).map(([s, label]) => (
        <span key={s} className={clsx('col-start-1 row-start-1 flex items-center gap-1 whitespace-nowrap', s !== state && 'invisible')}>
          {s === 'copied' && <CheckIcon size={iconSize} weight="bold" />}
          {label}
        </span>
      ))}
    </span>
  );
}

function Segment<T extends string | number>({ value, items, onPick }: {
  value: T;
  items: { id: T; label: string; dim?: boolean; title?: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="flex max-w-full shrink-0 overflow-x-auto rounded border border-border">
      {items.map((it) => (
        <button
          key={it.id}
          type="button"
          tabIndex={-1}
          title={it.title}
          aria-pressed={it.id === value}
          onClick={() => onPick(it.id)}
          className={popupButton({
            selected: it.id === value,
            class: clsx('shrink-0 whitespace-nowrap border-r border-border last:border-r-0', it.dim && it.id !== value && 'opacity-50'),
          })}
        >
          {it.label}
        </button>
      ))}
    </div>
  );
}

function Mark({ index, kind, auto, onFlip }: { index: number; kind: BreakKind; auto: BreakKind; onFlip: (index: number, kind: BreakKind) => void }) {
  const edited = kind !== auto;
  return (
    <button
      type="button"
      tabIndex={-1}
      title={`${MARK_TITLE[kind]}${edited ? ' (changed by hand)' : ''}. Click to cycle.`}
      onClick={() => onFlip(index, kind)}
      className={clsx(
        'mx-px inline-flex h-[15px] min-w-4 items-center justify-center rounded-sm border px-px align-[-3px] leading-none',
        kind === 'keep' ? 'border-border text-muted hover:text-foreground' : 'border-focus-ring bg-focus-ring/15 text-foreground',
        edited && 'border-dashed outline outline-1 outline-offset-1 outline-focus-ring/60',
      )}
    >
      {MARK_GLYPH[kind]}
    </button>
  );
}

/** The clipboard lines in `text`, as the footer counts them. */
const lineCount = (text: string) => (text ? text.split('\n').length : 0);

/** The most lines and characters any format's text has. */
function mostCounted(renderings: FormatRenderings): { lines: number; ch: number } {
  const texts = Object.values(renderings).map((r) => r.text);
  return { lines: Math.max(...texts.map(lineCount)), ch: Math.max(...texts.map((t) => t.length)) };
}

/** One run of pieces per clipboard line, a kept break ending its line, and
 *  the gutter's width in digits. */
function previewLines(rendering: Rendering): { lines: Piece[][]; gutterCh: number } {
  const lines: Piece[][] = [[]];
  for (const p of rendering.pieces) {
    lines[lines.length - 1].push(p);
    if (p.t === 'break' && p.kind === 'keep') lines.push([]);
  }
  return { lines, gutterCh: String(lines.length).length };
}

/** One gutter-numbered clipboard line, `gutterCh` digits wide. */
function PreviewRow({ n, gutterCh, pieces, onFlip }: { n: number; gutterCh: number; pieces: Piece[]; onFlip: (index: number, kind: BreakKind) => void }) {
  return (
    <div className="flex hover:bg-foreground/5">
      <span
        className="shrink-0 select-none border-r border-border pr-1.5 pl-2 text-right text-muted/70"
        style={{ width: `calc(${gutterCh}ch + 0.875rem)` }}
      >
        {n + 1}
      </span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap px-2 [overflow-wrap:anywhere]">
        {pieces.map((p, i) => {
          if (p.t === 'break') return <Mark key={i} index={p.index} kind={p.kind} auto={p.auto} onFlip={onFlip} />;
          const text = p.lead ? p.text.replace(/ /g, '·').replace(/\t/g, '→') : p.text;
          return <span key={i} className={clsx(p.lead && 'text-muted/60', p.added && COPY_EXPANDED_TEXT_CLASS)}>{text}</span>;
        })}
      </div>
    </div>
  );
}

/** One row per line that lands on the clipboard. Memoized: the store notifies
 *  every pane's editor for any pane's selection change. */
const LinedPreview = memo(function LinedPreview({ rendering, onFlip }: {
  rendering: Rendering;
  onFlip: (index: number, kind: BreakKind) => void;
}) {
  if (rendering.text === '') return <div className="px-2 py-1.5 text-xs italic text-muted">(empty)</div>;
  const { lines, gutterCh } = previewLines(rendering);
  return (
    <div className={PREVIEW_LINES_CLASS}>
      {lines.map((pieces, n) => <PreviewRow key={n} n={n} gutterCh={gutterCh} pieces={pieces} onFlip={onFlip} />)}
    </div>
  );
});

/** A line's rough width in cells, for ranking: a mark takes about two. */
const pieceWeight = (p: Piece) => (p.t === 'text' ? p.text.length : 2);

/** The `count` heaviest of `lines`, heaviest first and the earlier on a tie,
 *  each weighed once. */
function heaviestLines(lines: Piece[][], count: number): { pieces: Piece[]; n: number }[] {
  const top: { pieces: Piece[]; n: number; weight: number }[] = [];
  lines.forEach((pieces, n) => {
    const weight = pieces.reduce((sum, p) => sum + pieceWeight(p), 0);
    if (top.length === count && weight <= top[count - 1].weight) return;
    const at = top.findIndex((t) => weight > t.weight);
    top.splice(at < 0 ? top.length : at, 0, { pieces, n, weight });
    if (top.length > count) top.pop();
  });
  return top;
}

/** `pieces` cut once they reach `cells`, weighed as `heaviestLines` weighs them. */
function cutToCells(pieces: Piece[], cells: number): Piece[] {
  const cut: Piece[] = [];
  let used = 0;
  for (const p of pieces) {
    if (used >= cells) break;
    if (p.t === 'text' && used + p.text.length > cells) {
      cut.push({ ...p, text: p.text.slice(0, cells - used) });
      break;
    }
    cut.push(p);
    used += pieceWeight(p);
  }
  return cut;
}

/** The cells a probed line keeps: the widest the window could grow to, which
 *  the screen bounds, and a margin. Past that the editor is capped anyway. */
const probeCells = () => (typeof window === 'undefined'
  ? Infinity
  : Math.ceil(Math.max(window.innerWidth, window.screen.width) / PROBE_MIN_CELL_PX) + PROBE_MARGIN_CELLS);

/** Each format's few longest lines, each beside its own gutter, unwrapped in
 *  the `w-max` probe: the widest of them is the editor's natural width. */
const WidthProbe = memo(function WidthProbe({ renderings }: { renderings: FormatRenderings }) {
  const cells = probeCells();
  return Object.entries(renderings).map(([format, rendering]) => {
    const { lines, gutterCh } = previewLines(rendering);
    return (
      <div key={format} className={PREVIEW_LINES_CLASS}>
        {heaviestLines(lines, PROBE_LINES).map(({ pieces, n }) => (
          <PreviewRow key={n} n={n} gutterCh={gutterCh} pieces={cutToCells(pieces, cells)} onFlip={noFlip} />
        ))}
      </div>
    );
  });
});

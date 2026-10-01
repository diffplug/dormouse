import { clsx } from 'clsx';
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { CheckIcon } from '@phosphor-icons/react';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  getMouseSelectionSnapshot,
  setSelection,
  subscribeToMouseSelection,
  subscribeToRenderTick,
  type CopyEditorState,
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
import { COPY_EDITOR_Z_INDEX, COPY_EXPANDED_TEXT_CLASS, modalActionButton, modalSurface, popupButton, Shortcut } from './design';
import { createHeightMeasurer, measureNaturalWidth, type CopyEditorParts } from './copy-editor-measure';
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

/** Geometry is the motion driver's alone: React sets none of it, so a render
 *  never undoes a frame, and never sets `visibility` again after mounting, so
 *  the driver's first write is what shows it. */
const ROOT_STYLE: CSSProperties = { position: 'fixed', zIndex: COPY_EDITOR_Z_INDEX, contain: 'layout paint', visibility: 'hidden' };

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
  const { selection, copyEditor, copyFlash, programCopy } = states.get(terminalId) ?? DEFAULT_MOUSE_SELECTION_STATE;
  if (!workspaceActive || !copyEditor || !selection) return null;
  return <OpenCopyEditor terminalId={terminalId} selection={selection} editor={copyEditor} copyFlash={copyFlash} programCopy={programCopy} />;
}

/** What placement reads, as last rendered. */
interface Placed {
  selection: Selection;
  scope: Span;
  touch: boolean;
  zoomedId: string | null;
  workspaceId: string | null;
}

/** True while the pane is out of sight, which the editor on `document.body`
 *  does not inherit, cheapest check first: another pane zoomed over it, which
 *  a terminal context floats above; its Wall in Workspace travel, a
 *  presentation the editor does not follow; or the pane hidden, as a parked
 *  leaf or a Tool's other face hides it. */
function concealed(anchor: Element, { zoomedId, workspaceId }: Placed): boolean {
  if (zoomedId !== null
    && anchor.closest('[data-lath-leaf]')?.getAttribute('data-lath-leaf') !== zoomedId
    && !anchor.closest('[data-terminal-context]')) return true;
  if (workspaceId !== null && workspaceInTravel(workspaceId)) return true;
  return getComputedStyle(anchor).visibility === 'hidden';
}

/** Mounted while the editor is open, so closing drops its motion and side. */
const OpenCopyEditor = memo(function OpenCopyEditor({ terminalId, selection, editor, copyFlash, programCopy }: {
  terminalId: string;
  selection: Selection;
  editor: CopyEditorState;
  copyFlash: EditorFormat | null;
  programCopy: string | null;
}) {
  const touchUi = useContext(TouchUiContext);
  const zoomedId = useContext(ZoomedIdContext);
  const workspaceId = useContext(WorkspaceIdContext);
  const subscribeLayoutFrames = useContext(LayoutFramesContext);

  // Each scope's formats are rendered once and cached on it (`copy-editor.ts`),
  // so `f`, the duplicate check, the width probe, and the copy all reuse them.
  const rendering = useMemo(() => editorRendering(editor, programCopy), [editor, programCopy]);
  const renderings = useMemo(() => formatRenderings(editor, programCopy), [editor, programCopy]);
  const sameAs = useMemo(() => duplicateFormats(renderings), [renderings]);
  const onFlip = useCallback((index: number, kind: BreakKind) => flipCopyBreak(terminalId, index, kind), [terminalId]);
  const scope = editor.scopes[editor.scope].span;

  const anchorRef = useRef<HTMLSpanElement>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const headerRef = useRef<HTMLDivElement>(null);
  const previewRef = useRef<HTMLDivElement>(null);
  const footerRef = useRef<HTMLDivElement>(null);
  const probeRef = useRef<HTMLDivElement>(null);
  const motionRef = useRef<RectMotion | null>(null);
  const sideRef = useRef<CopyEditorSide | null>(null);
  const naturalWidthRef = useRef(0);
  const heightAtRef = useRef<(width: number) => number>(() => 0);
  const placedRef = useRef<Placed | null>(null);

  const parts = useCallback((): CopyEditorParts => ({
    root: rootRef.current!,
    header: headerRef.current!,
    preview: previewRef.current!,
    footer: footerRef.current!,
    probe: probeRef.current!,
  }), []);

  /** Place the editor against the selection and pane as they are now. */
  const recompute = useCallback(() => {
    const root = rootRef.current;
    const anchor = anchorRef.current;
    const motion = motionRef.current;
    const placed = placedRef.current;
    if (!root || !anchor || !motion || !placed) return;
    const dims = concealed(anchor, placed) ? null : getTerminalOverlayDims(terminalId);
    if (!dims || dims.rows === 0 || dims.elementWidth === 0) {
      if (root.dataset.copyEditorSide === undefined) return; // already hidden
      motion.hide();
      root.style.visibility = 'hidden';
      delete root.dataset.copyEditorSide;
      return;
    }
    const { side, rect } = placeCopyEditor({
      viewport: overlayViewportBounds(),
      pane: { left: dims.elementLeft, top: dims.elementTop, width: dims.elementWidth, height: dims.elementHeight },
      band: selectionBand(dims, [spanOfSelection(placed.selection), placed.scope]),
      naturalWidth: naturalWidthRef.current,
      naturalHeight: heightAtRef.current,
      touch: placed.touch,
      previous: sideRef.current,
    });
    sideRef.current = side;
    root.dataset.copyEditorSide = side;
    motion.setTarget(rect);
  }, [terminalId]);

  useLayoutEffect(() => {
    const root = rootRef.current!;
    const motion = createRectMotion({
      write: (r) => {
        root.style.left = `${r.left}px`;
        root.style.top = `${r.top}px`;
        root.style.width = `${r.width}px`;
        root.style.height = `${r.height}px`;
        root.style.visibility = 'visible';
      },
    });
    motionRef.current = motion;
    const unmap = setPortalAnchor(root, anchorRef.current!);
    return () => {
      motion.dispose();
      motionRef.current = null;
      sideRef.current = null;
      root.style.visibility = 'hidden';
      unmap();
    };
  }, []);

  // The width shows every format's longest line whole, so `f` and a flipped
  // mark never change it; a scope, a nudge, or an offer may.
  useLayoutEffect(() => {
    naturalWidthRef.current = measureNaturalWidth(parts());
  }, [parts, scope, programCopy]);

  useLayoutEffect(() => {
    heightAtRef.current = createHeightMeasurer(parts());
  }, [parts, rendering]);

  // Before paint, so opening lands placed with no travel, and every selection,
  // scope, or text change re-places it at once.
  useLayoutEffect(() => {
    placedRef.current = { selection, scope, touch: touchUi, zoomedId, workspaceId };
    recompute();
  }, [selection, scope, rendering, touchUi, zoomedId, workspaceId, recompute]);

  // Anything else that moves the pane or the band, coalesced to one placement
  // a frame: output and scrolling, the pane's own motion, the window.
  useEffect(() => {
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
    ];
    return () => {
      for (const unsubscribe of unsubscribes) unsubscribe();
      if (frame !== null) cancelAnimationFrame(frame);
    };
  }, [recompute, subscribeLayoutFrames]);

  useEffect(() => {
    const onMouseDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest(`[data-copy-editor-for="${terminalId}"]`)) setSelection(terminalId, null);
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [terminalId]);

  const edited = isEdited(editor);
  const lines = rendering.text ? rendering.text.split('\n').length : 0;
  const fromProgram = editor.format === 'program';
  const formatName = (f: EditorFormat) => (f === 'program' ? `From ${programName(terminalId)}` : FORMAT_NAMES[f]);
  const keys = (node: ReactNode) => (touchUi ? null : <span className="whitespace-nowrap text-xs text-muted">{node}</span>);

  const root = (
    <div
      ref={rootRef}
      data-copy-editor-for={terminalId}
      style={ROOT_STYLE}
      className={modalSurface({ padding: 'none', elevation: 'modal', class: 'flex flex-col overflow-hidden border-foreground/20 text-sm' })}
      // Portaled, its React events still bubble to the pane: keep its presses
      // from focusing the pane and its right-click from opening the terminal
      // context. It never takes focus, so keys stay with the pane (§4.5), but
      // a press on the preview's own box, its scrollbar, keeps its drag.
      onMouseDown={(e) => {
        e.stopPropagation();
        if (e.target !== previewRef.current) e.preventDefault();
      }}
      onContextMenu={(e) => e.stopPropagation()}
    >
      <div ref={headerRef} className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        {/* The program's own copy has no scope of Dormouse's to expand. */}
        <div className={clsx('flex min-w-0 items-center gap-2', fromProgram && 'pointer-events-none opacity-50')}>
          <Segment
            value={editor.scope}
            onPick={(i) => setCopyScope(terminalId, i)}
            items={editor.scopes.map((s, i) => ({ id: i, label: s.label }))}
          />
          {editor.scopes.length > 1 && keys(<><Shortcut>e</Shortcut> expand <Shortcut>{SHIFT}e</Shortcut> shrink</>)}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Segment
            value={editor.format}
            onPick={(f) => setCopyFormat(terminalId, f)}
            items={editorFormats(programCopy).map((f) => ({
              id: f,
              label: `${formatName(f)}${f === editor.format && edited ? '*' : ''}`,
              dim: !!sameAs[f],
              title: sameAs[f] ? `${FORMAT_BLURBS[f]}: same text as ${formatName(sameAs[f]!)}` : FORMAT_BLURBS[f],
            }))}
          />
          {keys(<><Shortcut>f</Shortcut> <Shortcut>{SHIFT}f</Shortcut></>)}
        </div>
      </div>
      {/* A stable gutter: a classic scrollbar appearing never narrows the lines. */}
      <div ref={previewRef} className="min-h-10 flex-1 overflow-auto bg-app-bg [scrollbar-gutter:stable]">
        <LinedPreview rendering={rendering} onFlip={onFlip} />
      </div>
      <div ref={footerRef} className="flex shrink-0 items-center gap-3 border-t border-border px-2 py-1 text-xs text-muted">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span><span className="text-foreground">{MARK_GLYPH.keep}</span> kept</span>
          <span><span className="text-foreground">{MARK_GLYPH.space}</span> space</span>
          <span><span className="text-foreground">{MARK_GLYPH.none}</span> joined</span>
          {editor.scope > 0 && <span><span className={clsx(COPY_EXPANDED_TEXT_CLASS, 'px-0.5 text-foreground')}>abc</span> expanded</span>}
        </span>
        {selection.shape !== 'block' && keys(<><Shortcut>{LEFT}{RIGHT}</Shortcut> end <Shortcut>{SHIFT}{LEFT}{RIGHT}</Shortcut> start</>)}
        <span className="ml-auto shrink-0 whitespace-nowrap">
          {lines} {lines === 1 ? 'line' : 'lines'} · {rendering.text.length} ch
        </span>
        {keys(<Shortcut>{COPY_CHORD_LABEL}</Shortcut>)}
        <button
          type="button"
          tabIndex={-1}
          onClick={() => void copySelection(terminalId)}
          className={modalActionButton({ tone: 'primary', class: 'flex shrink-0 items-center gap-1 py-0.5' })}
        >
          {copyFlash && <CheckIcon size={12} weight="bold" />}
          Copy
        </button>
      </div>
      <div ref={probeRef} aria-hidden inert className="invisible absolute left-0 top-0 w-max">
        <WidthProbe renderings={renderings} />
      </div>
    </div>
  );

  // In `document.body`, free of the pane's clipping and of any Workspace's
  // stacking context; the anchor keeps its presses inside the pane for DOM
  // containment checks (`anchoredTarget`). The server renderer has no portals.
  return (
    <>
      <span ref={anchorRef} hidden data-copy-editor-anchor="" />
      {typeof document === 'undefined' ? root : createPortal(root, document.body)}
    </>
  );
});

function Segment<T extends string | number>({ value, items, onPick }: {
  value: T;
  items: { id: T; label: string; dim?: boolean; title?: string }[];
  onPick: (v: T) => void;
}) {
  return (
    <div className="flex min-w-0 overflow-x-auto rounded border border-border">
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

/** One run of pieces per clipboard line: a kept break ends its line. */
function previewLines(rendering: Rendering): Piece[][] {
  const lines: Piece[][] = [[]];
  for (const p of rendering.pieces) {
    lines[lines.length - 1].push(p);
    if (p.t === 'break' && p.kind === 'keep') lines.push([]);
  }
  return lines;
}

const noFlip = () => {};

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
  const lines = previewLines(rendering);
  const gutterCh = String(lines.length).length;
  return (
    <div className={PREVIEW_LINES_CLASS}>
      {lines.map((pieces, n) => <PreviewRow key={n} n={n} gutterCh={gutterCh} pieces={pieces} onFlip={onFlip} />)}
    </div>
  );
});

/** A line's rough width in cells, for ranking: a mark takes about two. */
const lineWeight = (pieces: Piece[]) => pieces.reduce((sum, p) => sum + (p.t === 'text' ? p.text.length : 2), 0);

/** Each format's few longest lines, each beside its own gutter, unwrapped in
 *  the `w-max` probe: the widest of them is the editor's natural width. */
const WidthProbe = memo(function WidthProbe({ renderings }: { renderings: FormatRenderings }) {
  return Object.entries(renderings).map(([format, rendering]) => {
    const lines = previewLines(rendering);
    const gutterCh = String(lines.length).length;
    const longest = lines.map((pieces, n) => ({ pieces, n })).sort((a, b) => lineWeight(b.pieces) - lineWeight(a.pieces)).slice(0, PROBE_LINES);
    return (
      <div key={format} className={PREVIEW_LINES_CLASS}>
        {longest.map(({ pieces, n }) => <PreviewRow key={n} n={n} gutterCh={gutterCh} pieces={pieces} onFlip={noFlip} />)}
      </div>
    );
  });
});

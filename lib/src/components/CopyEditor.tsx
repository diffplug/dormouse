import { clsx } from 'clsx';
import { memo, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useState, useSyncExternalStore, type CSSProperties, type ReactNode } from 'react';
import { CheckIcon } from '@phosphor-icons/react';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  getMouseSelectionSnapshot,
  getRenderTick,
  setSelection,
  subscribeToMouseSelection,
  subscribeToRenderTick,
} from '../lib/mouse-selection';
import { COPY_FORMATS, spanOfSelection, type BreakKind, type CopyFormat, type Piece, type Rendering } from '../lib/copy-text';
import { duplicateFormats, editorRendering, flipCopyBreak, formatRenderings, setCopyFormat, setCopyScope } from '../lib/copy-editor';
import { copySelection } from '../lib/copy-selection';
import { getTerminalInstance, getTerminalOverlayDims } from '../lib/terminal-registry';
import { IS_MAC } from '../lib/platform';
import { modalActionButton, modalSurface, popupButton, Shortcut } from './design';
import { TouchUiContext } from './touch-ui-context';
import { WorkspaceActiveContext } from './wall/wall-context';

/** Shift, and the arrow keys, as the mobile compass rose writes them
 *  (`lib/src/lib/mobile-gesture-menu.ts`). */
const SHIFT = '⬆︎';
const LEFT = '◀';
const RIGHT = '▶';

const COPY_FORMAT_NAMES: Record<CopyFormat, string> = {
  auto: 'Auto',
  exact: 'Exact',
  spaces: 'Spaces',
  joined: 'No breaks',
};

const FORMAT_BLURBS: Record<CopyFormat, string> = {
  auto: 'each line break judged on its own',
  exact: 'as displayed',
  spaces: 'every line break becomes one space',
  joined: 'every line break deleted',
};

const MARK_GLYPH: Record<BreakKind, string> = { keep: '⏎', space: '␣', none: '⌁' };
const MARK_TITLE: Record<BreakKind, string> = {
  keep: 'Line break kept',
  space: 'Line break became one space',
  none: 'Line break deleted, joining the two sides',
};

/** Below this the editor overlays the selection rather than squeezing beside it. */
const MIN_HEIGHT_PX = 120;
const GAP_PX = 4;

interface Placement {
  top?: number;
  bottom?: number;
  maxHeight: number;
}

/**
 * The copy editor over a finalized selection (docs/specs/mouse-and-clipboard.md
 * §4): the text a copy would produce, at full pane width, with a mark on every
 * line break it crossed. Keys are handled by the Wall
 * (`handle-mouse-selection-keys.ts`); this owns the pointer.
 */
export function CopyEditor({ terminalId }: { terminalId: string }) {
  const touchUi = useContext(TouchUiContext);
  const states = useSyncExternalStore(subscribeToMouseSelection, getMouseSelectionSnapshot);
  const renderTick = useSyncExternalStore(subscribeToRenderTick, getRenderTick);
  // A hidden Workspace consumes no window input (docs/specs/layout.md →
  // "Workspaces"); the selection stays in the store for the way back.
  const workspaceActive = useContext(WorkspaceActiveContext);

  const state = states.get(terminalId) ?? DEFAULT_MOUSE_SELECTION_STATE;
  const { selection, copyEditor, copyFlash } = state;
  const open = workspaceActive && !!copyEditor;
  const terminal = open ? getTerminalInstance(terminalId) : null;
  // Every format at the scope is rendered once per scope, so `f` and the
  // duplicate check reuse it; only a per-break edit renders again.
  const scope = copyEditor?.scopes[copyEditor.scope].span;
  const renderings = useMemo(
    () => (terminal && selection && scope ? formatRenderings(terminal, selection, scope) : null),
    [terminal, selection, scope],
  );
  const rendering = useMemo(
    () => (terminal && selection && copyEditor && renderings ? editorRendering(terminal, selection, copyEditor, renderings) : null),
    [terminal, selection, copyEditor, renderings],
  );
  const sameAs = useMemo(() => (renderings ? duplicateFormats(renderings) : {}), [renderings]);
  const onFlip = useCallback((index: number, kind: BreakKind) => flipCopyBreak(terminalId, index, kind), [terminalId]);

  const [placement, setPlacement] = useState<Placement | null>(null);
  useLayoutEffect(() => {
    if (!open || !selection) {
      setPlacement(null);
      return;
    }
    const dims = getTerminalOverlayDims(terminalId);
    if (!dims || dims.rows === 0) return;
    const span = spanOfSelection(selection);
    const row = (r: number) => Math.max(0, Math.min(dims.rows, r - dims.viewportY));
    const below = dims.gridTop + row(span.end.row + 1) * dims.cellHeight + GAP_PX;
    const above = dims.gridTop + row(span.start.row) * dims.cellHeight - GAP_PX;
    const roomBelow = dims.elementHeight - below - GAP_PX;
    const roomAbove = above - GAP_PX;
    let next: Placement;
    if (Math.max(roomBelow, roomAbove) < MIN_HEIGHT_PX) {
      // The selection fills the pane: dock at the bottom, over it.
      next = { bottom: GAP_PX, maxHeight: Math.max(MIN_HEIGHT_PX, Math.floor(dims.elementHeight * 0.6)) };
    } else if (touchUi ? roomAbove < MIN_HEIGHT_PX : roomBelow >= roomAbove) {
      // Touch prefers above, clear of the thumb that ended the drag.
      next = { top: below, maxHeight: roomBelow };
    } else {
      next = { bottom: dims.elementHeight - above, maxHeight: roomAbove };
    }
    // The render tick fires for every pane at up to 60 Hz: keep the previous
    // object when nothing moved so React bails out.
    setPlacement((prev) => (prev && prev.top === next.top && prev.bottom === next.bottom && prev.maxHeight === next.maxHeight ? prev : next));
  }, [terminalId, open, selection, touchUi, renderTick]);

  useEffect(() => {
    if (!open) return;
    const onMouseDown = (ev: MouseEvent) => {
      const target = ev.target as HTMLElement | null;
      if (!target?.closest(`[data-copy-editor-for="${terminalId}"]`)) setSelection(terminalId, null);
    };
    window.addEventListener('mousedown', onMouseDown, true);
    return () => window.removeEventListener('mousedown', onMouseDown, true);
  }, [open, terminalId]);

  if (!rendering || !placement || !copyEditor || !selection) return null;

  const edited = Object.keys(copyEditor.overrides).length > 0;
  const keys = (node: ReactNode) => (touchUi ? null : <span className="whitespace-nowrap text-xs text-muted">{node}</span>);
  const style: CSSProperties = {
    position: 'absolute',
    left: GAP_PX,
    right: GAP_PX,
    top: placement.top,
    bottom: placement.bottom,
    maxHeight: placement.maxHeight,
    zIndex: 20,
  };

  return (
    <div
      data-copy-editor-for={terminalId}
      style={style}
      className={clsx(modalSurface({ padding: 'none', elevation: 'modal' }), 'flex flex-col overflow-hidden border-foreground/20 text-sm')}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="flex shrink-0 flex-col gap-1 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 items-center gap-2">
          <Segment
            value={copyEditor.scope}
            onPick={(i) => setCopyScope(terminalId, i)}
            items={copyEditor.scopes.map((s, i) => ({ id: i, label: s.label }))}
          />
          {copyEditor.scopes.length > 1 && keys(<><Shortcut>e</Shortcut> expand <Shortcut>{SHIFT}e</Shortcut> shrink</>)}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <Segment
            value={copyEditor.format}
            onPick={(f) => setCopyFormat(terminalId, f)}
            items={COPY_FORMATS.map((f) => ({
              id: f,
              label: `${COPY_FORMAT_NAMES[f]}${f === copyEditor.format && edited ? '*' : ''}`,
              dim: !!sameAs[f],
              title: sameAs[f] ? `${FORMAT_BLURBS[f]}: same text as ${COPY_FORMAT_NAMES[sameAs[f]!]}` : FORMAT_BLURBS[f],
            }))}
          />
          {keys(<><Shortcut>f</Shortcut> <Shortcut>{SHIFT}f</Shortcut></>)}
        </div>
      </div>
      <div className="min-h-10 flex-1 overflow-auto bg-app-bg">
        <LinedPreview rendering={rendering} onFlip={onFlip} />
      </div>
      <div className="flex shrink-0 items-center gap-3 border-t border-border px-2 py-1 text-xs text-muted">
        <span className="flex items-center gap-2 whitespace-nowrap">
          <span><span className="text-foreground">{MARK_GLYPH.keep}</span> kept</span>
          <span><span className="text-foreground">{MARK_GLYPH.space}</span> space</span>
          <span><span className="text-foreground">{MARK_GLYPH.none}</span> joined</span>
          {copyEditor.scope > 0 && <span><span className={clsx(ADDED_CLASS, 'px-0.5 text-foreground')}>abc</span> expanded</span>}
        </span>
        {selection.shape !== 'block' && keys(<><Shortcut>{LEFT}{RIGHT}</Shortcut> end <Shortcut>{SHIFT}{LEFT}{RIGHT}</Shortcut> start</>)}
        <span className="ml-auto shrink-0 whitespace-nowrap">
          {rendering.lines} {rendering.lines === 1 ? 'line' : 'lines'} · {rendering.text.length} ch
        </span>
        {keys(<Shortcut>{IS_MAC ? 'Cmd+C' : 'Ctrl+C'}</Shortcut>)}
        <button
          type="button"
          onClick={() => void copySelection(terminalId)}
          className={modalActionButton({ tone: 'primary', class: 'flex shrink-0 items-center gap-1 py-0.5' })}
        >
          {copyFlash && <CheckIcon size={12} weight="bold" />}
          Copy
        </button>
      </div>
    </div>
  );
}

const ADDED_CLASS = 'rounded-[2px] bg-success/15 underline decoration-success decoration-dotted underline-offset-2';

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

/** One gutter-numbered row per line that lands on the clipboard. Memoized: the
 *  editor re-renders on every render tick to place itself. */
const LinedPreview = memo(function LinedPreview({ rendering, onFlip }: {
  rendering: Rendering;
  onFlip: (index: number, kind: BreakKind) => void;
}) {
  if (rendering.text === '') return <div className="px-2 py-1.5 text-xs italic text-muted">(empty)</div>;
  const lines: ReactNode[][] = [[]];
  rendering.pieces.forEach((p: Piece, i) => {
    const line = lines[lines.length - 1];
    if (p.t === 'text') {
      const text = p.lead ? p.text.replace(/ /g, '·').replace(/\t/g, '→') : p.text;
      line.push(<span key={i} className={clsx(p.lead && 'text-muted/60', p.added && ADDED_CLASS)}>{text}</span>);
      return;
    }
    line.push(<Mark key={i} index={p.index} kind={p.kind} auto={p.auto} onFlip={onFlip} />);
    if (p.kind === 'keep') lines.push([]);
  });
  const gutterCh = String(lines.length).length;
  return (
    <div className="py-1 font-mono text-sm leading-[18px] text-foreground">
      {lines.map((parts, n) => (
        <div key={n} className="flex hover:bg-foreground/5">
          <span
            className="shrink-0 select-none border-r border-border pr-1.5 pl-2 text-right text-muted/70"
            style={{ width: `calc(${gutterCh}ch + 0.875rem)` }}
          >
            {n + 1}
          </span>
          <div className="min-w-0 flex-1 whitespace-pre-wrap px-2 [overflow-wrap:anywhere]">{parts}</div>
        </div>
      ))}
    </div>
  );
});

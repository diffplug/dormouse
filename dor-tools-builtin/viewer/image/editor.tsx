/** A self-contained raster image editor: one pixel layer plus markup objects
 * above it, flattened at image resolution on save. It lays out to fill its
 * parent and owns no window-level listeners, so a page can host it whole or
 * as an overlay. Remount it (a new `key`) to load other pixels. */
import { useEffect, useImperativeHandle, useLayoutEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent, type ReactNode, type Ref, type RefObject } from 'react';
import { flushSync } from 'react-dom';
import type { DocumentEditor } from '../document-session';
import { EditorController, MARKUP, type Revision, type Tool } from './controller';
import { Icon, type IconName } from './icons';
import { decodeImage, type LoadedImage } from './io';
import { contrast, fontSize } from './objects';
import { toHex } from './pixels';
import { pageTheme, subscribeTheme } from '../page-theme';
import './image.css';

export interface ImageEditorHandle {
  /** Commits pending edits (a floating selection, an open label) and starts
   * encoding them; `mark` names the revision the blob holds. */
  snapshot(): { content: Promise<Blob>; mark: Revision };
  /** The current revision, committing nothing. */
  revision(): Revision;
  /** Whether the editor still shows revision `mark`. */
  holds(mark: Revision): boolean;
}

export interface ImageEditorProps {
  /** The pixels to edit, read once at mount, and the format a save encodes
   * to: PNG, or JPEG at quality 0.92, with the file's color metadata. */
  image: LoadedImage;
  name: string;
  /** After every document change. */
  onChange?(): void;
  /** The host's own controls (its Save and Close), at the toolbar's end. */
  controls?: ReactNode;
  /** The host's error, shown over the canvas. */
  error?: string | null;
  ref?: Ref<ImageEditorHandle>;
}

/** The editor behind `ref` as a document session edits it; `show` mounts a
 * fresh editor over the decoded file, which is behind `ref` once it returns. */
export function editorDocument(ref: RefObject<ImageEditorHandle | null>, show: (image: LoadedImage, name: string) => void): DocumentEditor<Revision, Blob> {
  return {
    snapshot: () => ref.current!.snapshot(),
    mark: () => ref.current!.revision(),
    holds: mark => ref.current!.holds(mark),
    async apply(blob, name) {
      const image = await decodeImage(blob);
      flushSync(() => show(image, name));
    },
  };
}

interface ToolInfo { tool: Tool; key: string; label: string; icon: IconName; hint?: string }
const TOOL_GROUPS: ToolInfo[][] = [
  [{ tool: 'select', key: 'v', label: 'Select', icon: 'select', hint: 'Move, resize, and restyle markup. ⌥-drag duplicates; Delete removes; double-click edits a label.' }],
  [
    { tool: 'arrow', key: 'a', label: 'Arrow', icon: 'arrow', hint: '⇧ snaps to 45°.' },
    { tool: 'rect', key: 'r', label: 'Rectangle', icon: 'rect', hint: '⇧ draws a square.' },
    { tool: 'ellipse', key: 'o', label: 'Ellipse', icon: 'ellipse', hint: '⇧ draws a circle.' },
    { tool: 'text', key: 't', label: 'Text', icon: 'text', hint: 'Click to type; Enter places it, ⇧Enter starts a new line.' },
    { tool: 'callout', key: 'n', label: 'Numbered callout', icon: 'callout', hint: 'Each click places the next number.' },
    { tool: 'highlight', key: 'h', label: 'Highlighter', icon: 'highlight' },
    { tool: 'redact', key: 'x', label: 'Redact', icon: 'redact', hint: 'An opaque box; saving replaces the pixels under it.' },
  ],
  [{ tool: 'crop', key: 'c', label: 'Crop', icon: 'crop', hint: 'Drag an area, adjust its handles, then Enter applies and Esc cancels.' }],
  [
    { tool: 'brush', key: 'b', label: 'Pencil', icon: 'brush', hint: 'Hard-edged pixels. ⇧-click draws a line from the last point; ⌥-click picks a color.' },
    { tool: 'bucket', key: 'g', label: 'Fill', icon: 'bucket', hint: 'Fills the touching pixels of the clicked color; ⌥-click picks a color.' },
    { tool: 'eyedropper', key: 'i', label: 'Pick color', icon: 'eyedropper' },
    { tool: 'marquee', key: 'm', label: 'Select pixels', icon: 'marquee', hint: 'Drag inside to move (⌥ duplicates), arrows nudge, Enter or Esc commits, Delete fills with the surrounding color.' },
    { tool: 'lasso', key: 'l', label: 'Lasso', icon: 'lasso', hint: 'Freehand pixel selection; moves like Select pixels.' },
  ],
  [
    { tool: 'seam', key: 's', label: 'Seam', icon: 'seam', hint: 'Drag across the image from a line: Insert opens that many rows or columns there; Remove (or ⌥-drag) cuts out the band you drag over.' },
    { tool: 'ruler', key: 'u', label: 'Ruler', icon: 'ruler', hint: 'Drag to measure in image pixels; ⇧ snaps to 45°.' },
  ],
];
const SHORTCUTS: Record<string, Tool> = Object.fromEntries(TOOL_GROUPS.flat().map(t => [t.key, t.tool]));
const SWATCHES = [
  ['#e5383b', 'Red'], ['#f77f00', 'Orange'], ['#ffd60a', 'Yellow'], ['#2dc653', 'Green'],
  ['#1e88e5', 'Blue'], ['#8e44ad', 'Purple'], ['#000000', 'Black'], ['#ffffff', 'White'],
] as const;

/** Toolbar buttons keep focus where it was, so Space and letters still reach the editor. */
const keepFocus = (e: { preventDefault(): void }) => e.preventDefault();

export function ImageEditor({ image, name, onChange, controls, error, ref }: ImageEditorProps) {
  const [ctl] = useState(() => new EditorController(image.raster, image));
  useSyncExternalStore(ctl.subscribe, ctl.getVersion);
  const theme = useSyncExternalStore(subscribeTheme, pageTheme);
  const root = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const hexRef = useRef<HTMLButtonElement>(null);

  ctl.hooks = { onChange, focus: () => root.current?.focus({ preventScroll: true }) };

  useLayoutEffect(() => {
    const detach = ctl.attach(canvas.current!);
    const el = stage.current!;
    // Sized now, so the first paint already fits the image.
    const resize = () => ctl.resize(el.clientWidth, el.clientHeight, window.devicePixelRatio || 1);
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(el);
    return () => { observer.disconnect(); detach(); };
  }, [ctl]);
  useEffect(() => { ctl.refreshTheme(); }, [ctl, theme]);
  useEffect(() => { root.current?.focus({ preventScroll: true }); }, []);

  useImperativeHandle(ref, () => ({
    snapshot() { const mark = ctl.settle(); return { content: ctl.encode(mark), mark }; },
    revision: () => ctl.doc,
    holds: mark => ctl.holds(mark),
  }));

  // Keys the editor leaves (Esc with nothing to back out of, Cmd/Ctrl+S) reach the host.
  function onKeyDown(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'TEXTAREA' || target.tagName === 'SELECT') return;
    if (target.tagName === 'INPUT' && ((target as HTMLInputElement).type !== 'range' || e.key.startsWith('Arrow'))) return;
    if (ctl.key(e.nativeEvent, SHORTCUTS)) { e.preventDefault(); e.stopPropagation(); }
  }

  async function copyHex(hex: string) {
    try {
      await navigator.clipboard.writeText(hex);
      setCopied('Copied');
    } catch {
      // No clipboard access here: select the text so Cmd/Ctrl+C can take it.
      if (hexRef.current) getSelection()?.selectAllChildren(hexRef.current);
      setCopied('Press Cmd/Ctrl+C to copy');
    }
    setTimeout(() => setCopied(null), 1500);
  }

  const { tool, picked, sel, crop, text } = ctl;
  const selected = ctl.selected();
  const raster = ctl.doc.raster;
  const hex = tool === 'eyedropper' && picked ? toHex(picked) : ctl.color;
  const showWidth = MARKUP.has(tool) && (tool !== 'select' || !!selected);

  return (
    <div ref={root} className="image-editor" tabIndex={-1} onKeyDown={onKeyDown} onKeyUp={e => ctl.keyUp(e.nativeEvent)} aria-label={`Image editor: ${name}`}>
      <div className="ie-bar" role="toolbar" aria-label="Tools">
        {TOOL_GROUPS.map((group, i) => (
          <div className="ie-group" key={i}>
            {group.map(t => (
              <button key={t.tool} type="button" className="ie-icon" aria-label={t.label} aria-pressed={tool === t.tool}
                title={`${t.label} [${t.key.toUpperCase()}]${t.hint ? `\n${t.hint}` : ''}`}
                onPointerDown={keepFocus} onClick={() => ctl.setTool(t.tool)}>
                <Icon name={t.icon} />
              </button>
            ))}
          </div>
        ))}
        <div className="ie-group">
          <button type="button" className="ie-icon" aria-label="Undo" title="Undo [Cmd/Ctrl+Z]" disabled={!ctl.canUndo} onPointerDown={keepFocus} onClick={() => ctl.undo()}><Icon name="undo" /></button>
          <button type="button" className="ie-icon" aria-label="Redo" title="Redo [Shift+Cmd/Ctrl+Z]" disabled={!ctl.canRedo} onPointerDown={keepFocus} onClick={() => ctl.redo()}><Icon name="redo" /></button>
        </div>
        <div className="ie-end">{controls}</div>
      </div>
      <div className="ie-bar ie-options">
        <div className="ie-group" role="group" aria-label="Color">
          {SWATCHES.map(([color, label]) => (
            <button key={color} type="button" className="ie-swatch" style={{ background: color }} aria-label={label} title={`${label} ${color}`}
              aria-pressed={ctl.color === color} onPointerDown={keepFocus} onClick={() => ctl.setColor(color)} />
          ))}
          <label className="ie-swatch ie-custom" title="Custom color" style={{ background: ctl.color, color: contrast(ctl.color) }}>
            +<input type="color" aria-label="Custom color" value={ctl.color} onChange={e => ctl.setColor(e.target.value)} />
          </label>
        </div>
        <ToolOptions ctl={ctl} showWidth={showWidth} />
        {image.note && <span className="ie-hint ie-note" title={image.note}>{image.note}</span>}
        <div className="ie-status" role="status">
          {copied && <span>{copied}</span>}
          <button ref={hexRef} type="button" className="ie-hex" title="Copy this color's hex" onClick={() => void copyHex(hex)}>
            <span className="ie-chip" style={{ background: hex.slice(0, 7) }} />{hex}
          </button>
          <CursorReadout ctl={ctl} />
          <span title="Image size, in pixels">{raster.width} × {raster.height}</span>
          <ZoomControls ctl={ctl} />
        </div>
      </div>
      {error && <div className="ie-error" role="alert">{error}</div>}
      <div ref={stage} className="ie-stage">
        <canvas ref={canvas} aria-label={`${name}, ${raster.width} by ${raster.height} pixels`} />
        {text && <LabelInput ctl={ctl} key={text.id ?? `${text.x},${text.y}`} />}
      </div>
      {(sel || crop) && <span className="ie-sr" aria-live="polite">{crop ? 'Crop: Enter applies, Escape cancels.' : 'Pixels selected.'}</span>}
      {selected && <span className="ie-sr" aria-live="polite">{selected.kind} selected</span>}
    </div>
  );
}

/** The pixel under the pointer: re-renders alone as the pointer moves. */
function CursorReadout({ ctl }: { ctl: EditorController }) {
  const text = useSyncExternalStore(ctl.subscribeCursor, ctl.getCursorText);
  return <span className="ie-cursor" title="Cursor, in image pixels">{text}</span>;
}

/** The zoom readout and its buttons: re-render alone as the zoom changes. */
function ZoomControls({ ctl }: { ctl: EditorController }) {
  const { zoom, fit } = useSyncExternalStore(ctl.subscribeZoom, ctl.getView);
  return (
    <span className="ie-zoom">
      <button type="button" aria-label="Zoom out" title="Zoom out [-]" onPointerDown={keepFocus} onClick={() => ctl.zoomStep(-1)}>−</button>
      <button type="button" title="Actual pixels [1]: one image pixel per screen pixel" onPointerDown={keepFocus} onClick={() => ctl.actualSize()}>{Math.round(zoom * 100)}%</button>
      <button type="button" aria-label="Zoom in" title="Zoom in [+]" onPointerDown={keepFocus} onClick={() => ctl.zoomStep(1)}>+</button>
      <button type="button" aria-pressed={fit} title="Fit to the pane [0]" onPointerDown={keepFocus} onClick={() => ctl.fit()}>Fit</button>
    </span>
  );
}

function ToolOptions({ ctl, showWidth }: { ctl: EditorController; showWidth: boolean }) {
  const { tool } = ctl;
  return (
    <div className="ie-group ie-tool-options">
      {showWidth && <Slider label="Width" title="Stroke width and text size [ and ]" min={1} max={20} value={ctl.width} onChange={v => ctl.setWidth(v)} />}
      {tool === 'brush' && <>
        <Slider label="Size" title="Pencil size in pixels [ and ]" min={1} max={64} value={ctl.brushSize} onChange={v => ctl.set('brushSize', v)} />
        <button type="button" className="ie-icon" aria-label="Square tip" title="Square tip" aria-pressed={ctl.brushShape === 'square'} onPointerDown={keepFocus} onClick={() => ctl.set('brushShape', 'square')}><Icon name="square" /></button>
        <button type="button" className="ie-icon" aria-label="Round tip" title="Round tip" aria-pressed={ctl.brushShape === 'round'} onPointerDown={keepFocus} onClick={() => ctl.set('brushShape', 'round')}><Icon name="round" /></button>
      </>}
      {tool === 'bucket' && <Slider label="Tolerance" title="How far a pixel's channels may differ from the clicked one and still fill (0 = exact)" min={0} max={255} value={ctl.tolerance} onChange={v => ctl.set('tolerance', v)} />}
      {tool === 'seam' && <span className="ie-segmented" role="group" aria-label="Seam mode">
        <button type="button" aria-pressed={ctl.seamMode === 'insert'} title="Drag from a line to open space there" onPointerDown={keepFocus} onClick={() => ctl.set('seamMode', 'insert')}>Insert</button>
        <button type="button" aria-pressed={ctl.seamMode === 'remove'} title="Drag over a band to cut it out (or ⌥-drag in Insert mode)" onPointerDown={keepFocus} onClick={() => ctl.set('seamMode', 'remove')}>Remove</button>
      </span>}
      {tool === 'crop' && (ctl.crop ? <>
        <button type="button" onPointerDown={keepFocus} onClick={() => ctl.applyCrop()} title="Apply the crop [Enter]">Apply</button>
        <button type="button" onPointerDown={keepFocus} onClick={() => ctl.cancelCrop()} title="Cancel [Esc]">Cancel</button>
      </> : <span className="ie-hint">Drag to choose the area to keep</span>)}
      {(tool === 'marquee' || tool === 'lasso') && ctl.sel && <>
        <span className="ie-hint">{ctl.floating ? 'Enter commits' : 'Drag inside to move'}</span>
        <button type="button" onPointerDown={keepFocus} onClick={() => ctl.deleteSelected()} title="Fill with the surrounding color [Delete]">Erase</button>
      </>}
    </div>
  );
}

function Slider({ label, title, min, max, value, onChange }: { label: string; title: string; min: number; max: number; value: number; onChange(v: number): void }) {
  return (
    <label className="ie-slider" title={title}>
      <span>{label}</span>
      <input type="range" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} />
      <span className="ie-value">{value}</span>
    </label>
  );
}

/** The inline editor for a text label, over the canvas at the label's place. */
function LabelInput({ ctl }: { ctl: EditorController }) {
  const t = ctl.text!;
  const [value, setValue] = useState(t.text);
  const at = ctl.toCss({ x: t.x, y: t.y });
  const size = fontSize(ctl.width) * ctl.cssScale;
  const lines = value.split('\n');
  return (
    <textarea
      className="ie-label" autoFocus spellCheck={false} aria-label="Label text" value={value}
      rows={lines.length}
      style={{ left: at.x, top: at.y, fontSize: size, color: ctl.color, width: `${Math.max(2, ...lines.map(l => l.length)) + 1.5}ch` }}
      onChange={e => { setValue(e.target.value); ctl.setText(e.target.value); }}
      onBlur={() => ctl.finishText(true)}
      onKeyDown={e => {
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ctl.finishText(true); ctl.hooks.focus?.(); }
        else if (e.key === 'Escape') { e.preventDefault(); ctl.finishText(false); ctl.hooks.focus?.(); }
        e.stopPropagation();
      }}
    />
  );
}

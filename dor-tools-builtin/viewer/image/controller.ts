/** The image editor's state and interaction, outside React: the document
 * history, the view, every tool's pointer and key handling, and painting the
 * canvas. The component renders chrome from it and re-renders on `subscribe`. */
import * as px from './pixels';
import type { Mask, Point, Raster, Rect, Rgba } from './pixels';
import * as ob from './objects';
import type { Shape } from './objects';
import { History, type Doc } from './history';
import { center, clampView, fitView, stepZoom, zoomAt, type View } from './view';

export type Tool =
  | 'select' | 'arrow' | 'rect' | 'ellipse' | 'text' | 'callout' | 'highlight' | 'redact' | 'crop'
  | 'brush' | 'bucket' | 'eyedropper' | 'marquee' | 'lasso' | 'seam' | 'ruler';
export type SeamMode = 'insert' | 'remove';
/** Names one document revision; compare by identity. */
export type Revision = Doc;

const MARKUP = new Set<Tool>(['select', 'arrow', 'rect', 'ellipse', 'text', 'callout', 'highlight', 'redact']);
const SELECTION = new Set<Tool>(['marquee', 'lasso']);

/** Pixels lifted off the raster, shown at (x, y) above `base` until committed. */
interface Floating { pixels: Raster; x: number; y: number; base: Raster }
interface PixelSelection { rect: Rect; mask?: Mask; outline?: readonly Point[]; floating?: Floating }
interface Drag { move(p: Point, e: PointerEvent): void; up(p: Point, e: PointerEvent): void; cancel?(): void }
export interface TextEdit { id: string | null; x: number; y: number; text: string }

const cloneRaster = (r: Raster): Raster => ({ width: r.width, height: r.height, data: r.data.slice() });
export const hexToRgba = (hex: string): Rgba =>
  [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16), 255];
const imageData = (r: Raster) => new ImageData(r.data as Uint8ClampedArray<ArrayBuffer>, r.width, r.height);
const inside = (r: Rect, p: Point) => p.x >= r.x && p.y >= r.y && p.x < r.x + r.width && p.y < r.y + r.height;

/** Snaps `q` to the nearest 45° from `a`. */
function snap45(a: Point, q: Point): Point {
  const angle = Math.round(Math.atan2(q.y - a.y, q.x - a.x) / (Math.PI / 4)) * (Math.PI / 4);
  const len = Math.hypot(q.x - a.x, q.y - a.y);
  return { x: a.x + Math.cos(angle) * len, y: a.y + Math.sin(angle) * len };
}

export class EditorController {
  readonly history: History;
  saved: Doc;
  tool: Tool = 'arrow';
  color = '#e5383b';
  width = 4;
  brushSize = 2;
  brushShape: 'square' | 'round' = 'square';
  tolerance = 0;
  seamMode: SeamMode = 'insert';
  selectedId: string | null = null;
  sel: PixelSelection | null = null;
  crop: Rect | null = null;
  ruler: { a: Point; b: Point } | null = null;
  seam: { axis: 'x' | 'y'; from: number; to: number; mode: SeamMode } | null = null;
  text: TextEdit | null = null;
  cursor: Point | null = null;
  picked: Rgba | null = null;
  view: View = { zoom: 1, x: 0, y: 0, fit: true };
  /** Bumped on every change the chrome shows. */
  version = 0;
  hooks: { onChange?(): void; onDirty?(dirty: boolean): void; focus?(): void } = {};

  private draft: Shape | null = null;
  private live: readonly Shape[] | null = null;
  private working: Raster | null = null;
  private lasso: Point[] | null = null;
  private drag: Drag | null = null;
  private lastBrush: Point | null = null;
  private spaceDown = false;
  private gestureZoom: number | null = null;
  private lastDirty = false;
  /** The previous press, to tell a double-click (pointer events carry no click count). */
  private lastPress = { time: 0, x: 0, y: 0 };
  private double = false;
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private dpr = 1;
  private frame = 0;
  private sized = false;
  private accent = '#0078d4';
  private checker: CanvasPattern | null = null;
  private readonly rasterCanvas = document.createElement('canvas');
  private shownRaster: Raster | null = null;
  private readonly floatCanvas = document.createElement('canvas');
  private shownFloat: Raster | null = null;
  private readonly listeners = new Set<() => void>();
  /** The raster size the view last laid out, to refit a fitted view when it changes. */
  private shownSize: { width: number; height: number };

  constructor(raster: Raster) {
    this.saved = { raster, objects: [] };
    this.shownSize = { width: raster.width, height: raster.height };
    this.history = new History(this.saved);
  }

  // --- Document -----------------------------------------------------------

  get doc(): Doc { return this.history.current; }
  get floating(): Floating | null { return this.sel?.floating ?? null; }
  get dirty(): boolean { return this.doc !== this.saved || !!this.floating; }
  get editing(): boolean { return !!this.drag; }
  objects(): readonly Shape[] { return this.live ?? this.doc.objects; }
  raster(): Raster { return this.working ?? this.floating?.base ?? this.doc.raster; }
  selected(): Shape | undefined { return this.selectedId ? this.objects().find(s => s.id === this.selectedId) : undefined; }

  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  getVersion = () => this.version;
  private notify() { this.version++; for (const listener of this.listeners) listener(); }

  /** Reports a document change to the host. */
  private changed() {
    const dirty = this.dirty;
    if (dirty !== this.lastDirty) { this.lastDirty = dirty; this.hooks.onDirty?.(dirty); }
    this.hooks.onChange?.();
  }
  private commit(doc: Doc) {
    this.history.commit(doc);
    this.afterDoc();
  }
  private afterDoc(shown = this.shownSize) {
    const r = this.doc.raster;
    this.shownSize = { width: r.width, height: r.height };
    if (this.view.fit && (shown.width !== r.width || shown.height !== r.height)) this.fit();
    if (this.selectedId && !this.doc.objects.some(s => s.id === this.selectedId)) this.selectedId = null;
    this.changed();
    this.notify();
    this.paint();
  }
  private setObjects(objects: readonly Shape[]) { this.commit({ raster: this.doc.raster, objects }); }
  private setRaster(raster: Raster, objects = this.doc.objects) {
    if (raster.width && raster.height) this.commit({ raster, objects });
  }

  get canUndo() { return !!this.floating || this.history.canUndo; }
  get canRedo() { return this.history.canRedo; }
  undo() {
    if (this.drag) return;
    this.finishText(true);
    if (this.floating) { this.sel = null; this.changed(); this.notify(); this.paint(); return; }
    if (this.history.undo()) { this.sel = null; this.crop = null; this.afterDoc(); }
  }
  redo() {
    if (this.drag) return;
    this.finishText(true);
    this.commitFloat();
    if (this.history.redo()) { this.sel = null; this.crop = null; this.afterDoc(); }
  }

  /** Commits pending edits and names the revision a save would write. */
  settle(): Revision {
    this.drag?.cancel?.();
    this.drag = null;
    this.finishText(true);
    this.commitFloat();
    return this.doc;
  }
  markSaved(revision: Revision) { this.saved = revision; this.changed(); this.notify(); }
  holds(revision: Revision) { return this.doc === revision && !this.floating; }

  // --- Tools and styles ---------------------------------------------------

  setTool(tool: Tool) {
    if (tool === this.tool) return;
    this.finishText(true);
    if (SELECTION.has(this.tool) && !SELECTION.has(tool)) { this.commitFloat(); this.sel = null; }
    if (this.tool === 'crop') this.crop = null;
    if (this.tool === 'ruler') this.ruler = null;
    if (!MARKUP.has(tool)) this.selectedId = null;
    this.tool = tool;
    this.notify();
    this.paint();
  }
  /** Sets the active color, and restyles the selected object. */
  setColor(color: string) {
    this.color = color;
    const s = this.selected();
    if (s && s.color !== color) this.setObjects(this.doc.objects.map(o => o.id === s.id ? { ...o, color } : o));
    else { this.notify(); this.paint(); }
  }
  /** Sets the stroke width, and restyles the selected object. */
  setWidth(width: number) {
    this.width = width;
    const s = this.selected();
    if (s && s.width !== width) this.setObjects(this.doc.objects.map(o => o.id === s.id ? { ...o, width } : o));
    else { this.notify(); this.paint(); }
  }
  set<K extends 'brushSize' | 'brushShape' | 'tolerance' | 'seamMode'>(key: K, value: this[K]) {
    this[key] = value;
    this.notify();
    this.paint();
  }
  deleteSelected() {
    const s = this.selected();
    if (s) { this.setObjects(this.doc.objects.filter(o => o.id !== s.id)); return true; }
    const sel = this.sel;
    if (!sel) return false;
    if (sel.floating) {
      // The lifted pixels go; the hole their lift filled stays.
      const base = sel.floating.base;
      this.sel = null;
      if (base !== this.doc.raster) this.setRaster(base); else { this.changed(); this.notify(); this.paint(); }
      return true;
    }
    const r = cloneRaster(this.doc.raster);
    px.fillHole(r, sel.rect, sel.mask, px.dominantBorderColor(r, sel.rect, sel.mask) ?? [0, 0, 0, 0]);
    this.sel = null;
    this.setRaster(r);
    return true;
  }
  selectAll() {
    this.setTool('marquee');
    this.commitFloat();
    this.sel = { rect: { x: 0, y: 0, width: this.doc.raster.width, height: this.doc.raster.height } };
    this.notify();
    this.paint();
  }
  applyCrop() {
    const c = this.crop;
    if (!c) return;
    this.crop = null;
    // The kept pixels stay where they are on screen, unless the view fits the image.
    if (!this.view.fit) this.view = { ...this.view, x: this.view.x + c.x * this.view.zoom, y: this.view.y + c.y * this.view.zoom };
    this.setRaster(px.crop(this.doc.raster, c), this.doc.objects.map(s => ob.move(s, -c.x, -c.y)));
  }
  cancelCrop() { this.crop = null; this.notify(); this.paint(); }
  /** Commits a floating selection into the raster and clears the selection. */
  commitFloat() {
    const f = this.floating;
    if (!f) return;
    const out = cloneRaster(f.base);
    px.paste(out, f.pixels, f.x, f.y);
    this.sel = null;
    this.setRaster(out);
  }
  clearSelection() { this.commitFloat(); this.sel = null; this.notify(); this.paint(); }
  private pick(p: Point) {
    const c = px.pixel(this.raster(), p.x, p.y);
    if (!c) return;
    this.picked = c;
    this.color = px.toHex([c[0], c[1], c[2], 255]);
    this.notify();
  }

  // --- Text ---------------------------------------------------------------

  private startText(shape: Extract<Shape, { kind: 'text' }> | undefined, p: Point) {
    if (shape) { this.color = shape.color; this.width = shape.width; }
    this.selectedId = shape?.id ?? null;
    this.text = shape
      ? { id: shape.id, x: shape.x, y: shape.y, text: shape.text }
      : { id: null, x: p.x, y: p.y - ob.fontSize(this.width) * 0.6, text: '' };
    this.notify();
    this.paint();
  }
  setText(text: string) { if (this.text) this.text = { ...this.text, text }; }
  /** Ends the inline label editor, keeping its text or discarding the edit. */
  finishText(keep: boolean) {
    const t = this.text;
    if (!t) return;
    this.text = null;
    const value = t.text.replace(/\s+$/, ''), objects = this.doc.objects;
    const old = t.id ? objects.find(s => s.id === t.id) : undefined;
    if (keep && old?.kind === 'text') {
      if (!value) return this.setObjects(objects.filter(s => s.id !== old.id));
      if (value !== old.text) return this.setObjects(objects.map(s => s.id === old.id ? { ...old, text: value } : s));
    } else if (keep && !t.id && value) {
      const shape: Shape = { kind: 'text', id: ob.newId(), color: this.color, width: this.width, x: t.x, y: t.y, text: value };
      this.selectedId = shape.id;
      return this.setObjects([...objects, shape]);
    }
    this.notify();
    this.paint();
  }

  // --- View ---------------------------------------------------------------

  /** Device pixels; the canvas's CSS box stays where layout puts it. */
  resize(cssWidth: number, cssHeight: number, dpr: number) {
    const canvas = this.canvas;
    if (!canvas) return;
    this.dpr = dpr;
    canvas.width = Math.max(1, Math.round(cssWidth * dpr));
    canvas.height = Math.max(1, Math.round(cssHeight * dpr));
    this.checker = null;
    if (!this.sized || this.view.fit) { this.sized = true; this.fit(); } else this.setView(this.view);
    this.paint();
  }
  private setView(view: View) {
    const r = this.doc.raster, c = this.canvas;
    this.view = c ? clampView(view, r.width, r.height, c.width, c.height) : view;
    this.paint();
    this.notify();
  }
  fit() {
    const r = this.doc.raster, c = this.canvas;
    if (c) this.setView(fitView(r.width, r.height, c.width, c.height));
  }
  actualSize() {
    const r = this.doc.raster, c = this.canvas;
    if (c) this.setView(center(1, r.width, r.height, c.width, c.height));
  }
  zoomStep(dir: 1 | -1) {
    const c = this.canvas;
    if (c) this.setView(zoomAt(this.view, stepZoom(this.view.zoom, dir), c.width / 2, c.height / 2));
  }
  /** Image pixels per device pixel of slop: a grab radius that stays the same on screen. */
  private slop() { return 6 * this.dpr / this.view.zoom; }
  private devicePoint(e: { clientX: number; clientY: number }): Point {
    const rect = this.canvas!.getBoundingClientRect();
    return { x: (e.clientX - rect.left) * this.dpr, y: (e.clientY - rect.top) * this.dpr };
  }
  private toImage(e: { clientX: number; clientY: number }): Point {
    const d = this.devicePoint(e);
    return { x: (d.x - Math.round(this.view.x)) / this.view.zoom, y: (d.y - Math.round(this.view.y)) / this.view.zoom };
  }
  /** Where image point `p` sits, in CSS pixels from the canvas's top-left. */
  toCss(p: Point): Point {
    return { x: (Math.round(this.view.x) + p.x * this.view.zoom) / this.dpr, y: (Math.round(this.view.y) + p.y * this.view.zoom) / this.dpr };
  }
  get cssScale() { return this.view.zoom / this.dpr; }

  // --- Canvas wiring ------------------------------------------------------

  /** Takes over `canvas`'s input and painting; returns the detach. */
  attach(canvas: HTMLCanvasElement): () => void {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.refreshTheme();
    const on = <K extends keyof HTMLElementEventMap>(type: K, fn: (e: HTMLElementEventMap[K]) => void, options?: AddEventListenerOptions) => {
      canvas.addEventListener(type, fn as EventListener, options);
      return () => canvas.removeEventListener(type, fn as EventListener, options);
    };
    // Safari reports trackpad pinches as gesture events, not ctrl+wheel.
    const gesture = (type: string, fn: (e: Event & { scale: number; clientX: number; clientY: number }) => void) => {
      canvas.addEventListener(type, fn as EventListener, { passive: false });
      return () => canvas.removeEventListener(type, fn as EventListener);
    };
    const off = [
      on('pointerdown', this.onPointerDown), on('pointermove', this.onPointerMove), on('pointerup', this.onPointerUp),
      on('pointercancel', this.onPointerCancel), on('pointerleave', this.onPointerLeave),
      on('wheel', this.onWheel, { passive: false }),
      gesture('gesturestart', e => { e.preventDefault(); this.gestureZoom = this.view.zoom; }),
      gesture('gesturechange', e => {
        e.preventDefault();
        if (this.gestureZoom === null) return;
        const d = this.devicePoint(e);
        this.setView(zoomAt(this.view, this.gestureZoom * e.scale, d.x, d.y));
      }),
      gesture('gestureend', e => { e.preventDefault(); this.gestureZoom = null; }),
    ];
    return () => {
      for (const remove of off) remove();
      cancelAnimationFrame(this.frame);
      this.frame = 0;
      this.canvas = this.ctx = null;
    };
  }
  /** Re-reads the accent the overlays draw in. */
  refreshTheme() {
    if (!this.canvas) return;
    const value = getComputedStyle(this.canvas).getPropertyValue('--vscode-focusBorder').trim();
    this.accent = value || '#0078d4';
    this.paint();
  }

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? (this.canvas?.clientHeight ?? 400) : 1;
    if (e.ctrlKey || e.metaKey) {
      // Trackpad pinch (and ctrl+wheel) zooms about the pointer.
      if (this.gestureZoom !== null) return;
      const d = this.devicePoint(e);
      this.setView(zoomAt(this.view, this.view.zoom * Math.exp(-e.deltaY * unit * 0.01), d.x, d.y));
    } else {
      // Two-finger scroll pans.
      this.setView({ ...this.view, x: this.view.x - e.deltaX * unit * this.dpr, y: this.view.y - e.deltaY * unit * this.dpr, fit: false });
    }
  };
  private onPointerDown = (e: PointerEvent) => {
    if (!e.isPrimary || this.drag) return;
    // Keeps focus in the editor (not on the canvas's ancestors' defaults); the
    // inline label editor's blur commits it.
    e.preventDefault();
    const wasEditing = !!this.text;
    this.hooks.focus?.();
    this.finishText(true);
    const p = this.toImage(e), now = performance.now();
    this.double = now - this.lastPress.time < 400 && Math.hypot(e.clientX - this.lastPress.x, e.clientY - this.lastPress.y) < 5;
    this.lastPress = { time: this.double ? 0 : now, x: e.clientX, y: e.clientY };
    let drag: Drag | null = null;
    if (e.button === 1 || (e.button === 0 && this.spaceDown)) drag = this.panDrag(e);
    else if (e.button === 0 && !(wasEditing && this.tool === 'text')) drag = this.toolDown(p, e);
    if (drag) {
      this.drag = drag;
      try { this.canvas!.setPointerCapture(e.pointerId); } catch { /* a synthetic pointer has nothing to capture */ }
    }
    this.updateCursor(p);
    this.notify();
    this.paint();
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!e.isPrimary) return;
    const p = this.toImage(e);
    const r = this.raster();
    this.cursor = p.x >= 0 && p.y >= 0 && p.x < r.width && p.y < r.height ? { x: Math.floor(p.x), y: Math.floor(p.y) } : null;
    if (this.drag) this.drag.move(p, e);
    this.updateCursor(p);
    this.notify();
    this.paint();
  };
  private onPointerUp = (e: PointerEvent) => {
    const drag = this.drag;
    if (!drag || !e.isPrimary) return;
    this.drag = null;
    drag.up(this.toImage(e), e);
    this.updateCursor(this.toImage(e));
    this.notify();
    this.paint();
  };
  private onPointerCancel = () => {
    this.drag?.cancel?.();
    this.drag = null;
    this.paint();
  };
  private onPointerLeave = () => {
    if (this.drag) return;
    this.cursor = null;
    this.notify();
    this.paint();
  };

  private updateCursor(p: Point) {
    const c = this.canvas;
    if (!c) return;
    let cursor = 'crosshair';
    if (this.spaceDown) cursor = this.drag ? 'grabbing' : 'grab';
    else if (this.tool === 'select' || MARKUP.has(this.tool)) {
      const s = this.selected(), slop = this.slop();
      const handle = s && ob.handles(s).find(h => Math.hypot(h.x - p.x, h.y - p.y) <= slop * 1.5);
      if (handle) cursor = handleCursor(handle.handle);
      else if (s && ob.hit(s, p, slop)) cursor = 'move';
      else if (this.tool === 'select') cursor = ob.hitTop(this.objects(), p, slop) ? 'move' : 'default';
      else if (this.tool === 'text') cursor = 'text';
    } else if (this.tool === 'crop' && this.crop) {
      const handle = ob.boxHandles(this.crop).find(h => Math.hypot(h.x - p.x, h.y - p.y) <= this.slop() * 1.5);
      cursor = handle ? handleCursor(handle.handle) : inside(this.crop, p) ? 'move' : 'crosshair';
    } else if (SELECTION.has(this.tool) && this.sel && this.inSelection(p)) cursor = 'move';
    if (c.style.cursor !== cursor) c.style.cursor = cursor;
  }

  // --- Drags --------------------------------------------------------------

  private panDrag(e: PointerEvent): Drag {
    const start = this.devicePoint(e), view = this.view;
    return {
      move: (_, ev) => {
        const d = this.devicePoint(ev);
        this.setView({ ...view, x: view.x + d.x - start.x, y: view.y + d.y - start.y, fit: false });
      },
      up: () => {},
    };
  }

  private toolDown(p: Point, e: PointerEvent): Drag | null {
    const slop = this.slop();
    switch (this.tool) {
      case 'select': return this.selectDown(p, e, slop);
      case 'arrow': case 'rect': case 'ellipse': case 'redact': case 'highlight': return this.markupDown(p, e, slop);
      case 'callout': return this.calloutDown(p, e, slop);
      case 'text': {
        const grab = this.grabSelected(p, e, slop, false);
        if (grab) return grab;
        const hitShape = ob.hitTop(this.doc.objects, p, slop);
        this.startText(hitShape?.kind === 'text' ? hitShape : undefined, p);
        return null;
      }
      case 'crop': return this.cropDown(p, slop);
      case 'brush': return e.altKey ? (this.pick(p), null) : this.brushDown(p, e);
      case 'bucket': {
        if (e.altKey) { this.pick(p); return null; }
        const r = cloneRaster(this.doc.raster);
        if (px.floodFill(r, p.x, p.y, hexToRgba(this.color), this.tolerance)) this.setRaster(r);
        return null;
      }
      case 'eyedropper':
        this.pick(p);
        return { move: q => this.pick(q), up: () => {} };
      case 'marquee': case 'lasso': return this.selectionDown(p, e);
      case 'seam': return this.seamDown(p);
      case 'ruler': return this.rulerDown(p);
    }
  }

  /** Grabs the selected object by a handle (to resize) or its body (to move; ⌥ duplicates). */
  private grabSelected(p: Point, e: PointerEvent, slop: number, body = true): Drag | null {
    const s = this.selected();
    if (!s) return null;
    const h = ob.handles(s).find(h => Math.hypot(h.x - p.x, h.y - p.y) <= slop * 1.5);
    if (h) return this.shapeDrag(s, p, (orig, q, ev) => ob.resize(orig, h.handle, ev.shiftKey && orig.kind === 'arrow'
      ? snap45(h.handle === 'start' ? { x: orig.x2, y: orig.y2 } : { x: orig.x1, y: orig.y1 }, q) : q));
    if (body && ob.hit(s, p, slop)) return this.moveDrag(s, p, e.altKey);
    return null;
  }
  private moveDrag(s: Shape, p: Point, duplicate: boolean): Drag {
    return this.shapeDrag(s, p, (orig, q, ev) => {
      let dx = q.x - p.x, dy = q.y - p.y;
      if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
      return ob.move(orig, dx, dy);
    }, duplicate);
  }
  private shapeDrag(shape: Shape, start: Point, transform: (orig: Shape, q: Point, e: PointerEvent) => Shape, duplicate = false): Drag {
    let list = this.doc.objects, target = shape, moved = duplicate;
    if (duplicate) {
      target = { ...shape, id: ob.newId() };
      if (target.kind === 'callout') target = { ...target, n: ob.nextCallout(list) };
      list = [...list, target];
      this.live = list;
    }
    this.selectedId = target.id;
    const index = list.findIndex(s => s.id === target.id);
    return {
      move: (q, e) => {
        if (q.x === start.x && q.y === start.y && !moved) return;
        moved = true;
        const next = transform(target, q, e);
        this.live = list.map((s, i) => i === index ? next : s);
      },
      up: () => {
        const live = this.live;
        this.live = null;
        if (moved && live) this.setObjects(live);
      },
      cancel: () => { this.live = null; this.selectedId = shape.id; },
    };
  }

  private selectDown(p: Point, e: PointerEvent, slop: number): Drag | null {
    const hitShape = ob.hitTop(this.doc.objects, p, slop);
    if (this.double && hitShape?.kind === 'text') { this.startText(hitShape, p); return null; }
    const grab = this.grabSelected(p, e, slop);
    if (grab) return grab;
    if (!hitShape) { this.selectedId = null; return null; }
    this.color = hitShape.color;
    this.width = hitShape.width;
    return this.moveDrag(hitShape, p, e.altKey);
  }

  private markupDown(p: Point, e: PointerEvent, slop: number): Drag | null {
    const grab = this.grabSelected(p, e, slop);
    if (grab) return grab;
    const base = { id: ob.newId(), color: this.color, width: this.width };
    const kind = this.tool as 'arrow' | 'rect' | 'ellipse' | 'redact' | 'highlight';
    const points: Point[] = [p];
    const make = (q: Point, shift: boolean): Shape => {
      if (kind === 'arrow') {
        const end = shift ? snap45(p, q) : q;
        return { ...base, kind, x1: p.x, y1: p.y, x2: end.x, y2: end.y };
      }
      if (kind === 'highlight') return { ...base, kind, points: [...points] };
      let w = q.x - p.x, h = q.y - p.y;
      if (shift) { const side = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * side; h = Math.sign(h || 1) * side; }
      const r = ob.normalize({ x: p.x, y: p.y, width: w, height: h });
      if (kind === 'redact') {
        const c = px.clipRect(this.doc.raster, r) ?? { x: Math.round(r.x), y: Math.round(r.y), width: 0, height: 0 };
        return { ...base, kind, x: c.x, y: c.y, w: c.width, h: c.height };
      }
      return { ...base, kind, x: r.x, y: r.y, w: r.width, h: r.height };
    };
    this.draft = make(p, false);
    this.selectedId = null;
    return {
      move: (q, ev) => {
        if (kind === 'highlight') {
          const last = points[points.length - 1];
          if (Math.hypot(q.x - last.x, q.y - last.y) < 1.5 * this.dpr / this.view.zoom) return;
          points.push(ev.shiftKey ? { x: q.x, y: points[0].y } : q);
        }
        this.draft = make(q, ev.shiftKey);
      },
      up: () => {
        const d = this.draft;
        this.draft = null;
        if (!d || ob.degenerate(d, slop)) { this.selectedId = ob.hitTop(this.doc.objects, p, slop)?.id ?? null; return; }
        this.selectedId = d.id;
        this.setObjects([...this.doc.objects, d]);
      },
      cancel: () => { this.draft = null; },
    };
  }

  private calloutDown(p: Point, e: PointerEvent, slop: number): Drag | null {
    const grab = this.grabSelected(p, e, slop);
    if (grab) return grab;
    const existing = ob.hitTop(this.doc.objects, p, slop);
    if (existing?.kind === 'callout') return this.moveDrag(existing, p, e.altKey);
    const shape: Shape = { kind: 'callout', id: ob.newId(), color: this.color, width: this.width, x: p.x, y: p.y, n: ob.nextCallout(this.doc.objects) };
    this.draft = shape;
    return {
      move: q => { this.draft = { ...shape, x: q.x, y: q.y }; },
      up: () => {
        const d = this.draft;
        this.draft = null;
        if (!d) return;
        this.selectedId = d.id;
        this.setObjects([...this.doc.objects, d]);
      },
      cancel: () => { this.draft = null; },
    };
  }

  private cropDown(p: Point, slop: number): Drag | null {
    const raster = this.doc.raster, c = this.crop;
    const clip = (r: Rect) => px.clipRect(raster, ob.normalize(r));
    if (c) {
      const h = ob.boxHandles(c).find(h => Math.hypot(h.x - p.x, h.y - p.y) <= slop * 1.5);
      if (h) return { move: q => { this.crop = clip(ob.resizeRect(c, h.handle, q)) ?? c; }, up: () => {} };
      if (inside(c, p)) {
        return {
          move: q => {
            const x = Math.max(0, Math.min(raster.width - c.width, Math.round(c.x + q.x - p.x)));
            const y = Math.max(0, Math.min(raster.height - c.height, Math.round(c.y + q.y - p.y)));
            this.crop = { ...c, x, y };
          },
          up: () => {},
        };
      }
    }
    const a = { x: Math.round(p.x), y: Math.round(p.y) };
    this.crop = null;
    return {
      move: q => { this.crop = clip({ x: a.x, y: a.y, width: Math.round(q.x) - a.x, height: Math.round(q.y) - a.y }); },
      up: () => { if (this.crop && this.crop.width < 2 && this.crop.height < 2) this.crop = null; },
      cancel: () => { this.crop = c; },
    };
  }

  private brushDown(p: Point, e: PointerEvent): Drag {
    const w = cloneRaster(this.doc.raster), color = hexToRgba(this.color);
    const size = this.brushSize, shape = this.brushShape;
    this.working = w;
    let last = e.shiftKey && this.lastBrush ? this.lastBrush : p;
    const stroke = (a: Point, b: Point) => {
      px.drawLine(w, a.x, a.y, b.x, b.y, size, color, shape);
      this.syncRaster(w, { x: Math.min(a.x, b.x) - size, y: Math.min(a.y, b.y) - size, width: Math.abs(a.x - b.x) + 2 * size + 2, height: Math.abs(a.y - b.y) + 2 * size + 2 });
    };
    stroke(last, p);
    last = p;
    return {
      move: q => { stroke(last, q); last = q; },
      up: () => { this.working = null; this.lastBrush = last; this.setRaster(w); },
      cancel: () => { this.working = null; },
    };
  }

  private inSelection(p: Point): boolean {
    const s = this.sel;
    if (!s) return false;
    const f = s.floating;
    return inside(f ? { x: f.x, y: f.y, width: f.pixels.width, height: f.pixels.height } : s.rect, p);
  }
  /** Lifts the selection into a floating copy: a move fills the hole, a duplicate leaves it. */
  private lift(duplicate: boolean): Floating | null {
    const s = this.sel;
    if (!s) return null;
    if (s.floating) return s.floating;
    const r = this.doc.raster;
    let floating: Floating;
    if (duplicate) floating = { pixels: px.copyRegion(r, s.rect, s.mask), x: s.rect.x, y: s.rect.y, base: r };
    else {
      const base = cloneRaster(r), lifted = px.liftSelection(base, s.rect, s.mask);
      if (!lifted) return null;
      floating = { pixels: lifted.pixels, x: lifted.at.x, y: lifted.at.y, base };
    }
    this.sel = { ...s, floating };
    this.changed();
    return floating;
  }
  /** Moves the selection by whole pixels, lifting it first. */
  nudge(dx: number, dy: number) {
    const f = this.lift(false);
    if (!f) return;
    f.x += dx; f.y += dy;
    this.notify();
    this.paint();
  }
  private selectionDown(p: Point, e: PointerEvent): Drag | null {
    const s = this.sel;
    if (s && this.inSelection(p)) {
      let f = s.floating;
      if (f && e.altKey) {
        // ⌥-drag on a floating selection stamps a copy where it is and keeps moving.
        const base = cloneRaster(f.base);
        px.paste(base, f.pixels, f.x, f.y);
        f = { ...f, base };
        this.sel = { ...s, floating: f };
      } else if (!f) f = this.lift(e.altKey) ?? undefined;
      if (!f) return null;
      const float = f, ox = f.x, oy = f.y;
      return {
        move: (q, ev) => {
          let dx = Math.round(q.x - p.x), dy = Math.round(q.y - p.y);
          if (ev.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
          float.x = ox + dx; float.y = oy + dy;
        },
        up: () => {},
      };
    }
    this.commitFloat();
    this.sel = null;
    const raster = this.doc.raster;
    if (this.tool === 'marquee') {
      const a = { x: Math.round(p.x), y: Math.round(p.y) };
      return {
        move: q => {
          const rect = px.clipRect(raster, { x: a.x, y: a.y, width: Math.round(q.x) - a.x, height: Math.round(q.y) - a.y });
          this.sel = rect ? { rect } : null;
        },
        up: () => {},
        cancel: () => { this.sel = null; },
      };
    }
    const points = [p];
    this.lasso = points;
    return {
      move: q => { points.push(q); },
      up: () => {
        this.lasso = null;
        const mask = px.polygonMask(raster.width, raster.height, points), rect = px.maskBounds(mask, raster.width, raster.height);
        this.sel = rect ? { rect, mask, outline: points } : null;
      },
      cancel: () => { this.lasso = null; },
    };
  }

  private seamDown(p: Point): Drag {
    const r = this.doc.raster;
    this.seam = null;
    return {
      move: (q, e) => {
        const axis = Math.abs(q.y - p.y) >= Math.abs(q.x - p.x) ? 'y' : 'x';
        const extent = axis === 'y' ? r.height : r.width, clamp = (n: number) => Math.max(0, Math.min(extent, Math.round(n)));
        const mode = e.altKey ? (this.seamMode === 'insert' ? 'remove' : 'insert') : this.seamMode;
        this.seam = { axis, from: clamp(axis === 'y' ? p.y : p.x), to: clamp(axis === 'y' ? q.y : q.x), mode };
        if (mode === 'insert') this.seam.to = this.seam.from + Math.abs(Math.round((axis === 'y' ? q.y - p.y : q.x - p.x)));
      },
      up: () => {
        const s = this.seam;
        this.seam = null;
        if (!s || s.from === s.to) return;
        const shift = (at: number, d: (start: number) => number) => this.doc.objects.map(o => {
          const b = ob.bounds(o), start = s.axis === 'y' ? b.y : b.x;
          if (start < at) return o;
          const amount = d(start);
          return ob.move(o, s.axis === 'x' ? amount : 0, s.axis === 'y' ? amount : 0);
        });
        if (s.mode === 'insert') {
          const n = s.to - s.from;
          this.setRaster(px.insertSeam(r, s.axis, s.from, n), shift(s.from, () => n));
        } else {
          const a = Math.min(s.from, s.to), b = Math.max(s.from, s.to);
          if (b - a >= (s.axis === 'y' ? r.height : r.width)) return;
          this.setRaster(px.removeSeam(r, s.axis, a, b), shift(a, start => start >= b ? a - b : a - start));
        }
      },
      cancel: () => { this.seam = null; },
    };
  }

  private rulerDown(p: Point): Drag {
    const a = { x: Math.round(p.x), y: Math.round(p.y) };
    this.ruler = { a, b: a };
    return {
      move: (q, e) => {
        const b = e.shiftKey ? snap45(a, q) : q;
        this.ruler = { a, b: { x: Math.round(b.x), y: Math.round(b.y) } };
      },
      up: () => { if (this.ruler && this.ruler.a.x === this.ruler.b.x && this.ruler.a.y === this.ruler.b.y) this.ruler = null; },
    };
  }

  // --- Keys ---------------------------------------------------------------

  /** Handles a key the editor owns; returns whether it did. */
  key(e: KeyboardEvent, shortcuts: Record<string, Tool>): boolean {
    const mod = e.metaKey || e.ctrlKey, k = e.key;
    if (this.drag) {
      if (k !== 'Escape') return false;
      this.drag.cancel?.();
      this.drag = null;
      this.notify();
      this.paint();
      return true;
    }
    if (mod) {
      const lower = k.toLowerCase();
      if (lower === 'z') { if (e.shiftKey) this.redo(); else this.undo(); return true; }
      if (lower === 'y') { this.redo(); return true; }
      if (lower === 'a') { this.selectAll(); return true; }
      if (k === '0') { this.fit(); return true; }
      if (k === '1') { this.actualSize(); return true; }
      if (k === '=' || k === '+') { this.zoomStep(1); return true; }
      if (k === '-') { this.zoomStep(-1); return true; }
      return false;
    }
    if (e.altKey && k.length === 1) return false;
    switch (k) {
      case 'Escape': return this.escape();
      case 'Enter':
        if (this.crop) { this.applyCrop(); return true; }
        if (this.sel) { this.clearSelection(); return true; }
        return false;
      case 'Delete': case 'Backspace': return this.deleteSelected();
      case 'ArrowLeft': case 'ArrowRight': case 'ArrowUp': case 'ArrowDown': {
        const step = e.shiftKey ? 10 : 1;
        const dx = k === 'ArrowLeft' ? -step : k === 'ArrowRight' ? step : 0, dy = k === 'ArrowUp' ? -step : k === 'ArrowDown' ? step : 0;
        if (this.sel) { this.nudge(dx, dy); return true; }
        const s = this.selected();
        if (s) { this.setObjects(this.doc.objects.map(o => o.id === s.id ? ob.move(o, dx, dy) : o)); return true; }
        return false;
      }
      case '[': case ']': {
        const d = k === ']' ? 1 : -1;
        if (this.tool === 'brush') this.set('brushSize', Math.max(1, Math.min(64, this.brushSize + d)));
        else this.setWidth(Math.max(1, Math.min(20, this.width + d)));
        return true;
      }
      case '0': this.fit(); return true;
      case '1': this.actualSize(); return true;
      case '=': case '+': this.zoomStep(1); return true;
      case '-': this.zoomStep(-1); return true;
      case ' ':
        if (!this.spaceDown) { this.spaceDown = true; if (this.canvas) this.canvas.style.cursor = 'grab'; }
        return true;
    }
    const tool = shortcuts[k.toLowerCase()];
    if (tool && !e.shiftKey) { this.setTool(tool); return true; }
    return false;
  }
  keyUp(e: KeyboardEvent) {
    if (e.key === ' ') { this.spaceDown = false; if (this.canvas) this.canvas.style.cursor = ''; }
  }
  /** Backs out of the innermost transient state; false when there is none. */
  escape(): boolean {
    if (this.crop) { this.cancelCrop(); return true; }
    if (this.sel) { this.clearSelection(); return true; }
    if (this.ruler) { this.ruler = null; this.notify(); this.paint(); return true; }
    if (this.selectedId) { this.selectedId = null; this.notify(); this.paint(); return true; }
    return false;
  }

  // --- Output -------------------------------------------------------------

  /** The document flattened at image resolution: raster, then objects in order. */
  static async encode(doc: Doc, mime: string): Promise<Blob> {
    const canvas = document.createElement('canvas');
    canvas.width = doc.raster.width; canvas.height = doc.raster.height;
    const ctx = canvas.getContext('2d')!;
    ctx.putImageData(imageData(doc.raster), 0, 0);
    for (const shape of doc.objects) ob.drawShape(ctx, shape);
    return new Promise((resolve, reject) => canvas.toBlob(
      blob => blob ? resolve(blob) : reject(new Error('This image could not be encoded.')),
      mime, mime === 'image/jpeg' ? 0.92 : undefined,
    ));
  }

  // --- Painting -----------------------------------------------------------

  paint() {
    if (!this.frame && this.canvas) this.frame = requestAnimationFrame(() => { this.frame = 0; this.draw(); });
  }
  /** Copies raster pixels into the canvas the view scales: all of them for a
   * new raster, else just `dirty`. */
  private syncRaster(r: Raster, dirty?: Rect) {
    const c = this.rasterCanvas;
    if (this.shownRaster !== r) {
      this.shownRaster = r;
      if (c.width !== r.width || c.height !== r.height) { c.width = r.width; c.height = r.height; }
      c.getContext('2d')!.putImageData(imageData(r), 0, 0);
      return;
    }
    const d = dirty && px.clipRect(r, dirty);
    if (d) c.getContext('2d')!.putImageData(imageData(r), 0, 0, d.x, d.y, d.width, d.height);
  }

  private draw() {
    const canvas = this.canvas, ctx = this.ctx;
    if (!canvas || !ctx) return;
    const dpr = this.dpr, W = canvas.width, H = canvas.height;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const r = this.raster();
    this.syncRaster(r);
    const z = this.view.zoom, ox = Math.round(this.view.x), oy = Math.round(this.view.y);
    const sx = (x: number) => ox + x * z, sy = (y: number) => oy + y * z;
    ctx.fillStyle = this.checker ??= this.makeChecker(ctx);
    ctx.fillRect(ox, oy, r.width * z, r.height * z);
    ctx.imageSmoothingEnabled = z < 1;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(this.rasterCanvas, ox, oy, r.width * z, r.height * z);
    const f = this.floating;
    if (f) {
      if (this.shownFloat !== f.pixels) {
        this.shownFloat = f.pixels;
        this.floatCanvas.width = f.pixels.width; this.floatCanvas.height = f.pixels.height;
        this.floatCanvas.getContext('2d')!.putImageData(imageData(f.pixels), 0, 0);
      }
      ctx.drawImage(this.floatCanvas, sx(f.x), sy(f.y), f.pixels.width * z, f.pixels.height * z);
    }

    // Objects, clipped to the image as a save would crop them.
    ctx.save();
    ctx.setTransform(z, 0, 0, z, ox, oy);
    ctx.beginPath();
    ctx.rect(0, 0, r.width, r.height);
    ctx.clip();
    for (const shape of this.objects()) if (shape.id !== this.text?.id) ob.drawShape(ctx, shape);
    if (this.draft) ob.drawShape(ctx, this.draft);
    ctx.restore();

    if (z >= 12) this.drawGrid(ctx, r, ox, oy, z);
    ctx.lineWidth = dpr;

    const s = this.selected();
    if (s && !this.text && (this.tool === 'select' || MARKUP.has(this.tool))) {
      const b = ob.bounds(s), pad = 3 * dpr;
      ctx.setLineDash([4 * dpr, 3 * dpr]);
      ctx.strokeStyle = this.accent;
      if (s.kind !== 'arrow') ctx.strokeRect(sx(b.x) - pad, sy(b.y) - pad, b.width * z + 2 * pad, b.height * z + 2 * pad);
      ctx.setLineDash([]);
      for (const h of ob.handles(s)) this.drawHandle(ctx, sx(h.x), sy(h.y));
    }

    const sel = this.sel;
    if (sel) {
      const dx = f ? f.x - sel.rect.x : 0, dy = f ? f.y - sel.rect.y : 0;
      this.ants(ctx, () => {
        if (sel.outline) sel.outline.forEach((p, i) => i ? ctx.lineTo(sx(p.x + dx), sy(p.y + dy)) : ctx.moveTo(sx(p.x + dx), sy(p.y + dy)));
        else ctx.rect(sx(sel.rect.x + dx) + 0.5, sy(sel.rect.y + dy) + 0.5, sel.rect.width * z - 1, sel.rect.height * z - 1);
        ctx.closePath();
      });
      if (f || this.drag) this.label(ctx, `${sel.rect.width} × ${sel.rect.height}  at ${sel.rect.x + dx}, ${sel.rect.y + dy}`, sx(sel.rect.x + dx), sy(sel.rect.y + dy) - 4 * dpr, 'above');
    }
    if (this.lasso) {
      const points = this.lasso;
      this.ants(ctx, () => points.forEach((p, i) => i ? ctx.lineTo(sx(p.x), sy(p.y)) : ctx.moveTo(sx(p.x), sy(p.y))));
    }

    const c = this.crop;
    if (c) {
      ctx.fillStyle = 'rgba(0,0,0,.5)';
      ctx.beginPath();
      ctx.rect(0, 0, W, H);
      ctx.rect(sx(c.x), sy(c.y), c.width * z, c.height * z);
      ctx.fill('evenodd');
      this.ants(ctx, () => ctx.rect(sx(c.x) + 0.5, sy(c.y) + 0.5, c.width * z - 1, c.height * z - 1));
      for (const h of ob.boxHandles(c)) this.drawHandle(ctx, sx(h.x), sy(h.y));
      this.label(ctx, `${c.width} × ${c.height}`, sx(c.x), sy(c.y) - 4 * dpr, 'above');
    }

    const seam = this.seam;
    if (seam) {
      const y = seam.axis === 'y';
      const a = Math.min(seam.from, seam.to), b = Math.max(seam.from, seam.to);
      ctx.fillStyle = seam.mode === 'remove' ? 'rgba(220,40,40,.35)' : 'rgba(40,140,255,.3)';
      if (y) ctx.fillRect(ox, sy(a), r.width * z, (b - a) * z); else ctx.fillRect(sx(a), oy, (b - a) * z, r.height * z);
      this.ants(ctx, () => {
        if (y) { ctx.moveTo(ox, sy(seam.from)); ctx.lineTo(ox + r.width * z, sy(seam.from)); }
        else { ctx.moveTo(sx(seam.from), oy); ctx.lineTo(sx(seam.from), oy + r.height * z); }
      });
      const text = seam.mode === 'remove' ? `Remove ${b - a} px` : `Insert ${b - a} px`;
      this.label(ctx, text, y ? ox + 4 * dpr : sx(b) + 4 * dpr, y ? sy(b) + 4 * dpr : oy + 4 * dpr, 'below');
    }

    const ruler = this.ruler;
    if (ruler) {
      const { a, b } = ruler;
      ctx.lineWidth = 3 * dpr; ctx.strokeStyle = 'rgba(0,0,0,.6)';
      ctx.beginPath(); ctx.moveTo(sx(a.x), sy(a.y)); ctx.lineTo(sx(b.x), sy(b.y)); ctx.stroke();
      ctx.lineWidth = dpr; ctx.strokeStyle = '#ffffff'; ctx.stroke();
      for (const p of [a, b]) this.drawHandle(ctx, sx(p.x), sy(p.y), 3);
      const dx = b.x - a.x, dy = b.y - a.y;
      this.label(ctx, `${Math.round(Math.hypot(dx, dy) * 10) / 10} px  (dx ${dx}, dy ${dy})`, sx(b.x) + 8 * dpr, sy(b.y) + 8 * dpr, 'below');
    }

    // The brush's footprint, pixel-exact, where it would land.
    const cur = this.cursor;
    if (cur && !this.drag && this.tool === 'brush' && !this.spaceDown) {
      const size = this.brushSize, start = -Math.floor((size - 1) / 2);
      this.ants(ctx, () => {
        if (this.brushShape === 'round' && size > 2) ctx.arc(sx(cur.x + start + size / 2), sy(cur.y + start + size / 2), size * z / 2, 0, Math.PI * 2);
        else ctx.rect(sx(cur.x + start) + 0.5, sy(cur.y + start) + 0.5, size * z - 1, size * z - 1);
      });
    } else if (cur && !this.drag && (this.tool === 'eyedropper' || this.tool === 'bucket') && z >= 4) {
      this.ants(ctx, () => ctx.rect(sx(cur.x) + 0.5, sy(cur.y) + 0.5, z - 1, z - 1));
    }
  }

  private drawGrid(ctx: CanvasRenderingContext2D, r: Raster, ox: number, oy: number, z: number) {
    const canvas = this.canvas!;
    const x0 = Math.max(0, Math.floor(-ox / z)), x1 = Math.min(r.width, Math.ceil((canvas.width - ox) / z));
    const y0 = Math.max(0, Math.floor(-oy / z)), y1 = Math.min(r.height, Math.ceil((canvas.height - oy) / z));
    ctx.beginPath();
    for (let x = x0; x <= x1; x++) { ctx.moveTo(ox + x * z + 0.5, oy + y0 * z); ctx.lineTo(ox + x * z + 0.5, oy + y1 * z); }
    for (let y = y0; y <= y1; y++) { ctx.moveTo(ox + x0 * z, oy + y * z + 0.5); ctx.lineTo(ox + x1 * z, oy + y * z + 0.5); }
    ctx.lineWidth = 1;
    ctx.strokeStyle = 'rgba(128,128,128,.35)';
    ctx.stroke();
  }
  /** A dashed black-and-white outline, visible over any pixels. */
  private ants(ctx: CanvasRenderingContext2D, path: () => void) {
    const dpr = this.dpr;
    ctx.save();
    ctx.lineWidth = dpr;
    ctx.beginPath();
    path();
    ctx.setLineDash([4 * dpr, 4 * dpr]);
    ctx.strokeStyle = '#ffffff';
    ctx.stroke();
    ctx.lineDashOffset = 4 * dpr;
    ctx.strokeStyle = '#000000';
    ctx.stroke();
    ctx.restore();
  }
  private drawHandle(ctx: CanvasRenderingContext2D, x: number, y: number, radius = 4) {
    const s = radius * this.dpr;
    ctx.fillStyle = '#ffffff';
    ctx.strokeStyle = this.accent;
    ctx.lineWidth = this.dpr;
    ctx.fillRect(x - s, y - s, 2 * s, 2 * s);
    ctx.strokeRect(x - s + 0.5, y - s + 0.5, 2 * s - 1, 2 * s - 1);
  }
  private label(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, where: 'above' | 'below') {
    const dpr = this.dpr, pad = 4 * dpr, h = 18 * dpr;
    ctx.save();
    ctx.font = `${11 * dpr}px system-ui, sans-serif`;
    const w = ctx.measureText(text).width + 2 * pad;
    const canvas = this.canvas!;
    x = Math.max(2, Math.min(canvas.width - w - 2, x));
    y = where === 'above' ? y - h : y;
    y = Math.max(2, Math.min(canvas.height - h - 2, y));
    ctx.fillStyle = 'rgba(0,0,0,.78)';
    ctx.fillRect(x, y, w, h);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x + pad, y + h / 2);
    ctx.restore();
  }
  private makeChecker(ctx: CanvasRenderingContext2D): CanvasPattern {
    const size = Math.round(8 * this.dpr), tile = document.createElement('canvas');
    tile.width = tile.height = size * 2;
    const t = tile.getContext('2d')!;
    t.fillStyle = '#ffffff'; t.fillRect(0, 0, size * 2, size * 2);
    t.fillStyle = '#e4e4e4'; t.fillRect(0, 0, size, size); t.fillRect(size, size, size, size);
    return ctx.createPattern(tile, 'repeat')!;
  }
}

function handleCursor(handle: ob.Handle): string {
  switch (handle) {
    case 'n': case 's': return 'ns-resize';
    case 'e': case 'w': return 'ew-resize';
    case 'nw': case 'se': return 'nwse-resize';
    case 'ne': case 'sw': return 'nesw-resize';
    default: return 'move';
  }
}

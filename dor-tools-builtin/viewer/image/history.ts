/** Undo and redo over editor documents. A revision's identity names it (the
 * save's dirty mark). A size-preserving pixel edit changes the current raster
 * in place and keeps only the tiles it touched, as the other side of the step
 * has them; other edits replace the raster, keeping the old one whole. The
 * current revision's raster always holds that revision's pixels. */
import { blit, clipRect, crop, type Raster, type Rect } from './pixels';
import type { Shape } from './objects';

export interface Doc { readonly raster: Raster; readonly objects: readonly Shape[] }
/** Pixels kept from a raster: `pixels` covers `rect`. */
export interface Tile { rect: Rect; pixels: Raster }
/** The pixels one in-place edit changed, within `rect`: `tiles` hold every
 * one of them as it was before, and may hold unchanged pixels too. */
export interface Patch { rect: Rect; tiles: readonly Tile[] }
/** What an undo or redo changed: in place within `rect`, or else the raster or objects whole. */
export interface Applied { rect?: Rect }

/** One step between consecutive revisions. A patch's tiles hold their pixels
 * as the revision the step leads away from has them: `from`'s while the step
 * can be undone, `to`'s once it was. */
interface Step { from: Doc; to: Doc; patch?: Patch; bytes: number }

/** Bytes kept for undo; the oldest steps go first past it. */
const HISTORY_BYTES = 256 * 1024 * 1024;

export class History {
  /** Oldest first; the last step's `to` is `current`. */
  private past: Step[] = [];
  /** Next redo last; its `from` is `current`. */
  private future: Step[] = [];
  private bytes = 0;
  constructor(public current: Doc, private limit = HISTORY_BYTES) {}

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  /** Makes `doc` current. With `patch`, which this takes, the caller already
   * changed the current raster in place (`doc.raster` is it). */
  commit(doc: Doc, patch?: Patch): void {
    if (doc === this.current) return;
    const from = this.current;
    // A patch is charged its tiles; a replaced raster is kept whole, charged to the step that leaves it.
    const bytes = patch ? patch.tiles.reduce((n, t) => n + t.pixels.data.byteLength, 0)
      : doc.raster !== from.raster ? from.raster.data.byteLength : 0;
    this.past.push({ from, to: doc, patch, bytes });
    this.bytes += bytes;
    this.current = doc;
    this.future = [];
    while (this.past.length && this.bytes > this.limit) this.bytes -= this.past.shift()!.bytes;
  }
  /** Steps back; null when there is nothing to undo. */
  undo(): Applied | null {
    const step = this.past.pop();
    if (!step) return null;
    this.bytes -= step.bytes;
    this.future.push(step);
    this.current = step.from;
    return swap(step);
  }
  /** Steps forward; null when there is nothing to redo. */
  redo(): Applied | null {
    const step = this.future.pop();
    if (!step) return null;
    this.past.push(step);
    this.bytes += step.bytes;
    this.current = step.to;
    return swap(step);
  }
}

/** One tile row in transit through `swap`, grown to the widest seen. */
let scratch = new Uint8ClampedArray(0);

/** Puts a patch step's kept tiles on the raster, keeping the pixels each
 * replaces: each tile and its spot on the raster trade rows in place, so an
 * undo or redo allocates no tile. */
function swap({ from, patch }: Step): Applied {
  if (!patch) return {};
  const { data, width } = from.raster;
  for (const { rect, pixels } of patch.tiles) {
    const rowBytes = rect.width * 4;
    if (scratch.length < rowBytes) scratch = new Uint8ClampedArray(rowBytes);
    const row = scratch.subarray(0, rowBytes);
    for (let y = 0; y < rect.height; y++) {
      const at = ((rect.y + y) * width + rect.x) * 4, kept = pixels.data.subarray(y * rowBytes, (y + 1) * rowBytes);
      row.set(data.subarray(at, at + rowBytes));
      data.set(kept, at);
      kept.set(row);
    }
  }
  return { rect: patch.rect };
}

/** The pixels an in-place edit of `raster` changes, each kept once, just
 * before it first changes, a tile at a time: memory follows the area the edit
 * touched however often it touches it, and undo needs no copy of the whole raster. */
export class Pieces {
  /** Each touched tile's pixels as the edit found them, by tile index. */
  private readonly kept = new Map<number, Tile>();
  private readonly columns: number;
  constructor(private readonly raster: Raster, private readonly tile = 64) {
    this.columns = Math.ceil(raster.width / tile);
  }

  /** Keeps `rect`'s pixels; call before changing them. Returns `rect`
   * clipped to the raster, or null when it is off it. */
  keep(rect: Rect): Rect | null {
    const clipped = clipRect(this.raster, rect), t = this.tile;
    if (!clipped) return null;
    for (let ty = Math.floor(clipped.y / t); ty * t < clipped.y + clipped.height; ty++) {
      for (let tx = Math.floor(clipped.x / t); tx * t < clipped.x + clipped.width; tx++) {
        const index = ty * this.columns + tx;
        // A tile kept earlier holds its pixels from before any change.
        if (this.kept.has(index)) continue;
        const at = clipRect(this.raster, { x: tx * t, y: ty * t, width: t, height: t })!;
        this.kept.set(index, { rect: at, pixels: crop(this.raster, at) });
      }
    }
    return clipped;
  }
  /** Hands over the kept tiles, the pixels as the edit found them, for a
   * `Patch`; this then keeps none. */
  take(): Tile[] {
    const tiles = [...this.kept.values()];
    this.kept.clear();
    return tiles;
  }
  /** Puts back every pixel the edit changed. */
  restore(): void {
    for (const { rect, pixels } of this.kept.values()) blit(this.raster, pixels, rect.x, rect.y);
  }
}

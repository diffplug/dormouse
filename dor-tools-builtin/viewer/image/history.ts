/** Undo and redo over editor documents. A revision's identity names it (the
 * save's dirty mark). A size-preserving pixel edit changes the current raster
 * in place and keeps only the rectangle it changed, as the other side of the
 * step has it; other edits replace the raster, keeping the old one whole. The
 * current revision's raster always holds that revision's pixels. */
import { blit, clipRect, crop, type Raster, type Rect } from './pixels';
import type { Shape } from './objects';

export interface Doc { readonly raster: Raster; readonly objects: readonly Shape[] }
/** The pixels one in-place edit changed: `before` covers `rect`. */
export interface Patch { rect: Rect; before: Raster }
/** What an undo or redo changed: in place within `rect`, or else the raster or objects whole. */
export interface Applied { rect?: Rect }

/** One step between consecutive revisions. A patch's `pixels` hold its
 * rectangle as the revision the step leads away from has it: `from`'s while
 * the step can be undone, `to`'s once it was. */
interface Step { from: Doc; to: Doc; patch?: { rect: Rect; pixels: Raster }; bytes: number }

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

  /** Makes `doc` current. With `patch`, the caller already changed the current
   * raster in place (`doc.raster` is it), within `patch.rect` from `patch.before`. */
  commit(doc: Doc, patch?: Patch): void {
    if (doc === this.current) return;
    const from = this.current;
    // A replaced raster is kept whole, charged to the step that leaves it.
    const bytes = patch ? patch.before.data.byteLength : doc.raster !== from.raster ? from.raster.data.byteLength : 0;
    this.past.push({ from, to: doc, patch: patch && { rect: patch.rect, pixels: patch.before }, bytes });
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

/** Puts a patch step's kept pixels on the raster, keeping the ones they replace. */
function swap({ from, patch }: Step): Applied {
  if (!patch) return {};
  const { rect, pixels } = patch;
  patch.pixels = crop(from.raster, rect);
  blit(from.raster, pixels, rect.x, rect.y);
  return { rect };
}

/** The pixels an in-place edit of `raster` changes, kept rectangle by
 * rectangle just before they change: undo needs no copy of the whole raster. */
export class Pieces {
  private readonly kept: { rect: Rect; pixels: Raster }[] = [];
  constructor(private readonly raster: Raster) {}

  /** Keeps `rect`'s pixels; call before changing them. Returns `rect`
   * clipped to the raster, or null when it is off it. */
  keep(rect: Rect): Rect | null {
    const clipped = clipRect(this.raster, rect);
    if (clipped) this.kept.push({ rect: clipped, pixels: crop(this.raster, clipped) });
    return clipped;
  }
  /** `rect`'s pixels as they were before the edit. Pieces overlap, and the
   * first to hold a pixel kept it unchanged, so it goes on last. */
  before(rect: Rect): Raster {
    const out = crop(this.raster, rect);
    for (let i = this.kept.length - 1; i >= 0; i--) {
      const { rect: at, pixels } = this.kept[i];
      blit(out, pixels, at.x - rect.x, at.y - rect.y);
    }
    return out;
  }
  /** Puts back every pixel the edit changed. */
  restore(): void {
    for (let i = this.kept.length - 1; i >= 0; i--) {
      const { rect, pixels } = this.kept[i];
      blit(this.raster, pixels, rect.x, rect.y);
    }
  }
}

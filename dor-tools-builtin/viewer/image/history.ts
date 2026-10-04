/** Undo and redo over editor documents. A revision's identity names it (the
 * save's dirty mark). A size-preserving pixel edit changes the current raster
 * in place and keeps only the rectangle it changed, before and after; other
 * edits replace the raster, keeping the old one whole. The current revision's
 * raster always holds that revision's pixels. */
import { blit, type Raster, type Rect } from './pixels';
import type { Shape } from './objects';

export interface Doc { readonly raster: Raster; readonly objects: readonly Shape[] }
/** The pixels one in-place edit changed: `before` and `after` cover `rect`. */
export interface Patch { rect: Rect; before: Raster; after: Raster }

/** One step between consecutive revisions. */
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

  /** Makes `doc` current. With `patch`, the caller already changed the current
   * raster in place (`doc.raster` is it), from `patch.before` to `patch.after`. */
  commit(doc: Doc, patch?: Patch): void {
    if (doc === this.current) return;
    const from = this.current;
    // A replaced raster is kept whole, charged to the step that leaves it.
    const bytes = patch ? patch.before.data.byteLength + patch.after.data.byteLength
      : doc.raster !== from.raster ? from.raster.data.byteLength : 0;
    this.past.push({ from, to: doc, patch, bytes });
    this.bytes += bytes;
    this.current = doc;
    this.future = [];
    while (this.past.length && this.bytes > this.limit) this.bytes -= this.past.shift()!.bytes;
  }
  undo(): boolean {
    const step = this.past.pop();
    if (!step) return false;
    this.bytes -= step.bytes;
    if (step.patch) blit(step.to.raster, step.patch.before, step.patch.rect.x, step.patch.rect.y);
    this.future.push(step);
    this.current = step.from;
    return true;
  }
  redo(): boolean {
    const step = this.future.pop();
    if (!step) return false;
    if (step.patch) blit(step.from.raster, step.patch.after, step.patch.rect.x, step.patch.rect.y);
    this.past.push(step);
    this.bytes += step.bytes;
    this.current = step.to;
    return true;
  }
}

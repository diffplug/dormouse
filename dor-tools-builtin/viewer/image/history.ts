/** Undo and redo over whole editor documents. A document is immutable once
 * committed, so revisions share every raster they did not change, and a
 * revision's identity names it (the save's dirty mark). */
import type { Raster } from './pixels';
import type { Shape } from './objects';

export interface Doc { readonly raster: Raster; readonly objects: readonly Shape[] }

/** Raster snapshots kept for undo, in bytes; the oldest go first past it. */
export const HISTORY_BYTES = 256 * 1024 * 1024;

export class History {
  private past: Doc[] = [];
  private future: Doc[] = [];
  constructor(public current: Doc, private limit = HISTORY_BYTES) {}

  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }

  commit(doc: Doc): void {
    if (doc === this.current) return;
    this.past.push(this.current);
    this.current = doc;
    this.future = [];
    this.trim();
  }
  undo(): boolean {
    const doc = this.past.pop();
    if (!doc) return false;
    this.future.push(this.current);
    this.current = doc;
    return true;
  }
  redo(): boolean {
    const doc = this.future.pop();
    if (!doc) return false;
    this.past.push(this.current);
    this.current = doc;
    return true;
  }

  /** Drops the oldest revisions while their distinct rasters exceed the limit. */
  private trim() {
    const bytes = () => {
      const seen = new Set<Raster>();
      for (const doc of [...this.past, this.current, ...this.future]) seen.add(doc.raster);
      let total = 0;
      for (const r of seen) total += r.data.byteLength;
      return total;
    };
    while (this.past.length && bytes() > this.limit) this.past.shift();
  }
}

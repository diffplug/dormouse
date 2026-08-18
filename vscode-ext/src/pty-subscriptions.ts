/** Reference counts for one router's foreign PTY streams. */
export class PtySubscriptions {
  readonly #counts = new Map<string, number>();

  has(ptyId: string): boolean {
    return this.#counts.has(ptyId);
  }

  /** Add one viewer; true only for the zero-to-one transition. */
  subscribe(ptyId: string): boolean {
    const count = this.#counts.get(ptyId) ?? 0;
    this.#counts.set(ptyId, count + 1);
    return count === 0;
  }

  /** Remove one viewer; true only for the one-to-zero transition. */
  unsubscribe(ptyId: string): boolean {
    const count = this.#counts.get(ptyId);
    if (count === undefined) return false;
    if (count > 1) {
      this.#counts.set(ptyId, count - 1);
      return false;
    }
    this.#counts.delete(ptyId);
    return true;
  }

  /** Release every underlying unique stream, regardless of viewer count. */
  releaseAll(release: (ptyId: string) => void): void {
    for (const ptyId of this.#counts.keys()) release(ptyId);
    this.#counts.clear();
  }
}

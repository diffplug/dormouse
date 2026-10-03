/**
 * Keeps one webview's iframe lease messages in order over a transport that may
 * reorder them (docs/specs/dor-browser.md → "Iframe Proxy Leases"). Tauri runs
 * an async command on a worker and a sync one on the main thread, so a
 * release sent after a create can reach the sidecar first — and a lease
 * minted after its own release is never released. Here every create waits for
 * the page's boot reset, and every release for each create of its lease still
 * being answered. VS Code's single ordered channel needs none of this.
 */
export class IframeLeaseOrder {
  /** The page's release of whatever a page it replaced left. */
  reset: Promise<unknown> = Promise.resolve();
  private readonly creating = new Map<string, Promise<void>>();

  create<T>(lease: string | undefined, send: () => Promise<T>): Promise<T> {
    const sent = this.reset.then(send);
    if (lease !== undefined) {
      const answered = sent.then(() => {}, () => {});
      const all = (this.creating.get(lease) ?? Promise.resolve()).then(() => answered);
      this.creating.set(lease, all);
      void all.then(() => { if (this.creating.get(lease) === all) this.creating.delete(lease); });
    }
    return sent;
  }

  release(lease: string, send: () => void): void {
    const pending = this.creating.get(lease);
    if (pending) void pending.then(send);
    else send();
  }
}

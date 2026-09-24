import { isAllowedPlaywrightBinary } from '../../lib/agent-browser-binary';
import type { BrowserBinding } from 'dor/commands/types';

/** Pin concurrent first commands to one native project until the Surface is
 *  bound. A reservation whose command never succeeds expires, so a failed first
 *  launch does not pin its key; one whose command succeeded but has no Surface
 *  (a browser no viewer can attach to) is kept, since its session exists. */
export class BrowserBindingReservations {
  private pending = new Map<string, { binding: BrowserBinding; expires: number }>();

  /** The binding reserved for `key`, else a new one from the caller's
   *  `proposed` cwd and executable; null when `proposed` carries no cwd. */
  resolve(key: string, proposed: unknown): BrowserBinding | null {
    const now = Date.now();
    for (const [pendingKey, entry] of this.pending) {
      if (entry.expires <= now) this.pending.delete(pendingKey);
    }
    const existing = this.pending.get(key);
    if (existing) return existing.binding;
    const p = proposed as { cwd?: unknown; binaryPath?: unknown } | undefined;
    if (typeof p?.cwd !== 'string') return null;
    // The session is minted here, never proposed: a key belongs to this Wall,
    // so its native name must not collide with another Wall's key.
    const binding: BrowserBinding = {
      session: `dormouse.pw.${crypto.randomUUID()}`,
      cwd: p.cwd,
      ...(isAllowedPlaywrightBinary(p.binaryPath) ? { binaryPath: p.binaryPath } : {}),
    };
    if (this.pending.size >= 1024) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(key, { binding, expires: now + 120_000 });
    return binding;
  }

  /** The key's command succeeded: keep its binding until a Surface takes it. */
  confirm(key: string) {
    const entry = this.pending.get(key);
    if (entry) entry.expires = Infinity;
  }

  delete(key: string) { this.pending.delete(key); }
}

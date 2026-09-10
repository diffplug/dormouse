import { isAllowedPlaywrightBinary } from '../../lib/agent-browser-binary';
import type { BrowserBinding } from 'dor/commands/types';
/** Pin concurrent first commands to one native project until the Surface is bound. */
export class BrowserBindingReservations {
  private pending = new Map<string, { binding: BrowserBinding; expires: number }>();
  resolve(key: string, proposed: unknown): BrowserBinding | null {
    const now = Date.now();
    for (const [key, entry] of this.pending) if (entry.expires <= now) this.pending.delete(key);
    const existing = this.pending.get(key);
    if (existing) return existing.binding;
    const p = proposed as Partial<BrowserBinding> | undefined;
    if (typeof p?.session !== 'string' || typeof p.cwd !== 'string') return null;
    // A key belongs to this Wall; native CLI names must not collide with another Wall's key.
    const binding = { session: `dormouse.pw.${crypto.randomUUID()}`, cwd: p.cwd, ...(isAllowedPlaywrightBinary(p.binaryPath) ? { binaryPath: p.binaryPath } : {}) };
    if (this.pending.size >= 1024) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(key, { binding, expires: now + 120_000 });
    return binding;
  }
  delete(key: string) { this.pending.delete(key); }
}

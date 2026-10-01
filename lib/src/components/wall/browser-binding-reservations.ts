import { sessionForKey, type BrowserAutomationProvider, type BrowserBinding } from 'dor-lib-common/browser-providers';
import { isAllowedBinaryFor } from '../../lib/agent-browser-binary';

/**
 * The binding of a managed `--key` no Surface holds yet
 * (docs/specs/dor-browser.md → "Managed identity"). Its session is minted
 * deterministically, `sessionForKey(key, scope)`, numbered past any session a
 * Surface in the Window already holds — one bound to that key before it left
 * this Workspace, say — or another key's reservation; what a reservation pins is
 * the caller's cwd and executable, so a key's concurrent first commands run in
 * one directory with one executable until its Surface is bound. A reservation
 * whose command never succeeds expires, so a failed first launch does not pin
 * its key; one whose command succeeded but has no Surface (a browser no viewer
 * can attach to) is kept, since its session exists.
 */
export class BrowserBindingReservations {
  private pending = new Map<string, { provider: BrowserAutomationProvider; binding: BrowserBinding; expires: number }>();

  /** `provider`'s binding for `key` in `scope`: the one reserved, else a new
   *  one — reserved with the caller's `proposed` cwd and executable when the
   *  command may bind a Surface, bare otherwise. `taken` answers whether a
   *  Surface holds a session. */
  resolve(provider: BrowserAutomationProvider, key: string, scope: string, proposed?: unknown, taken: (session: string) => boolean = () => false): BrowserBinding {
    const now = Date.now();
    for (const [pendingKey, entry] of this.pending) {
      if (entry.expires <= now) this.pending.delete(pendingKey);
    }
    const existing = this.pending.get(reservationKey(provider, key));
    if (existing) return existing.binding;
    // Another key's reservation holds its session too; another provider's
    // session of the same name is another browser.
    const reserved = new Set([...this.pending.values()].filter((entry) => entry.provider === provider).map((entry) => entry.binding.session));
    const base = sessionForKey(key, scope);
    let session = base;
    for (let n = 2; taken(session) || reserved.has(session); n++) session = `${base}.${n}`;
    const p = proposed as { cwd?: unknown; binaryPath?: unknown } | undefined;
    if (typeof p?.cwd !== 'string') return { session };
    const binding: BrowserBinding = {
      session,
      cwd: p.cwd,
      ...(isAllowedBinaryFor(provider, p.binaryPath) ? { binaryPath: p.binaryPath } : {}),
    };
    if (this.pending.size >= 1024) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(reservationKey(provider, key), { provider, binding, expires: now + 120_000 });
    return binding;
  }

  /** The key's command succeeded: keep its binding until a Surface takes it. */
  confirm(provider: BrowserAutomationProvider, key: string) {
    const entry = this.pending.get(reservationKey(provider, key));
    if (entry) entry.expires = Infinity;
  }

  delete(provider: BrowserAutomationProvider, key: string) {
    this.pending.delete(reservationKey(provider, key));
  }
}

// The same key driven by two providers is two browsers.
function reservationKey(provider: BrowserAutomationProvider, key: string): string {
  return `${provider}\0${key}`;
}

import { BROWSER_PROVIDERS, sessionForKey, type BrowserAutomationProvider } from 'dor-lib-common/browser-providers';
import type { BrowserBinding } from 'dor/commands/types';

/**
 * The binding of a managed `--key` no Surface holds yet
 * (docs/specs/dor-browser.md → "Managed identity"). Its session is minted
 * deterministically, `sessionForKey(key, scope)`; what a reservation pins is
 * the caller's cwd and executable, so a key's concurrent first commands run in
 * one directory with one executable until its Surface is bound. A reservation
 * whose command never succeeds expires, so a failed first launch does not pin
 * its key; one whose command succeeded but has no Surface (a browser no viewer
 * can attach to) is kept, since its session exists.
 */
export class BrowserBindingReservations {
  private pending = new Map<string, { binding: BrowserBinding; expires: number }>();

  /** `provider`'s binding for `key` in `scope`: the one reserved, else a new
   *  one — reserved with the caller's `proposed` cwd and executable when the
   *  command may bind a Surface, bare otherwise. */
  resolve(provider: BrowserAutomationProvider, key: string, scope: string, proposed?: unknown): BrowserBinding {
    const now = Date.now();
    for (const [pendingKey, entry] of this.pending) {
      if (entry.expires <= now) this.pending.delete(pendingKey);
    }
    const existing = this.pending.get(reservationKey(provider, key));
    if (existing) return existing.binding;
    const session = sessionForKey(key, scope);
    const p = proposed as { cwd?: unknown; binaryPath?: unknown } | undefined;
    if (typeof p?.cwd !== 'string') return { session };
    const binding: BrowserBinding = {
      session,
      cwd: p.cwd,
      ...(BROWSER_PROVIDERS[provider].isAllowedBinary(p.binaryPath) ? { binaryPath: p.binaryPath } : {}),
    };
    if (this.pending.size >= 1024) this.pending.delete(this.pending.keys().next().value!);
    this.pending.set(reservationKey(provider, key), { binding, expires: now + 120_000 });
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

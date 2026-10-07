/**
 * Presence windows: the Burrow's memory of the presence proofs it verified
 * (`docs/specs/remote-security-model.md` -> Presence window).
 *
 * Keyed by the IK-authenticated Client static, base64url as the ACL stores it.
 * Each entry names the identities its proof was verified for, so a redeem can
 * re-run the ACL conjunction against them and nothing else. In memory only,
 * and evaluated rather than reaped: an entry past its bounds reads as closed
 * and is dropped the next time anything asks about it.
 */

import { PRESENCE_WINDOW_IDLE_MS, PRESENCE_WINDOW_MAX_MS } from './e2e-bounds.js';

/** The identities a window's proof was verified for. */
export interface PresenceWindowRecord {
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  readonly passkeyPublicKeyHash: string;
}

export interface PresenceWindowEntry extends PresenceWindowRecord {
  /** When the Burrow verified the proof that opened or last refreshed it. */
  readonly provedAt: number;
  /** `provedAt`, or the latest Client activity folded in since. */
  readonly activeAt: number;
}

export interface PresenceWindowsOptions {
  /** Clock returning epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

export class PresenceWindows {
  readonly #entries = new Map<string, PresenceWindowEntry>();
  readonly #now: () => number;

  constructor(options: PresenceWindowsOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /**
   * Open, or refresh, the window for one Client static after the Burrow
   * verified a proof for `record` at `provedAt`. Replaces any entry outright.
   */
  seed(clientStaticPublicKey: string, record: PresenceWindowRecord, provedAt: number): void {
    this.#sweepCapped();
    this.#entries.set(clientStaticPublicKey, {
      accountId: record.accountId,
      passkeyCredentialId: record.passkeyCredentialId,
      passkeyPublicKeyHash: record.passkeyPublicKeyHash,
      provedAt,
      activeAt: provedAt,
    });
  }

  /**
   * Fold one session's Client activity in: its last decrypted Client->Burrow
   * message, live or ended. Never moves the activity back.
   */
  noteActivity(clientStaticPublicKey: string, at: number): void {
    const entry = this.#entries.get(clientStaticPublicKey);
    if (!entry || at <= entry.activeAt) return;
    this.#entries.set(clientStaticPublicKey, { ...entry, activeAt: at });
  }

  /**
   * The open window for one Client static, or `null`. Open means less than
   * {@link PRESENCE_WINDOW_IDLE_MS} since the latest activity and less than
   * {@link PRESENCE_WINDOW_MAX_MS} since the proof.
   */
  open(clientStaticPublicKey: string): PresenceWindowEntry | null {
    const entry = this.#entries.get(clientStaticPublicKey);
    if (!entry) return null;
    const now = this.#now();
    if (now - entry.activeAt < PRESENCE_WINDOW_IDLE_MS && now - entry.provedAt < PRESENCE_WINDOW_MAX_MS) {
      return entry;
    }
    this.#entries.delete(clientStaticPublicKey);
    return null;
  }

  clear(): void {
    this.#entries.clear();
  }

  /** Entries held, open or not yet found closed; for the bound's own test. */
  get size(): number {
    return this.#entries.size;
  }

  /**
   * Drop every entry past the cap, which no activity can reopen. Idle ones
   * stay until asked about: a session still running under one may yet fold
   * activity in.
   */
  #sweepCapped(): void {
    const now = this.#now();
    for (const [key, entry] of this.#entries) {
      if (now - entry.provedAt >= PRESENCE_WINDOW_MAX_MS) this.#entries.delete(key);
    }
  }
}

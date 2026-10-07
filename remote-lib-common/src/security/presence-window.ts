/**
 * Presence windows: the Burrow's memory of the presence proofs it verified
 * (`docs/specs/remote-security-model.md` -> Presence window).
 *
 * Keyed by the IK-authenticated Client static, base64url as the ACL stores it.
 * Each entry names the ACL record its proof was verified for, so a redeem can
 * re-run the conjunction against that record and nothing else. In memory only,
 * and evaluated rather than reaped: an entry past its bounds reads as closed
 * and is dropped the next time anything asks about it.
 */

import { PRESENCE_WINDOW_IDLE_MS, PRESENCE_WINDOW_MAX_MS } from './e2e-bounds.js';

/** The ACL record a window was opened for; `approvedAt` tells a re-pairing apart. */
export interface PresenceWindowRecord {
  readonly accountId: string;
  readonly passkeyCredentialId: string;
  readonly passkeyPublicKeyHash: string;
  readonly approvedAt: number;
}

export interface PresenceWindowEntry extends PresenceWindowRecord {
  /** When the Burrow verified the proof that opened or last refreshed it. */
  readonly provedAt: number;
  /** `provedAt`, or the latest activity folded in from a session that has ended. */
  readonly activeAt: number;
}

/**
 * Client activity under one record: a live session's last decrypted
 * Client->Burrow message, or an ended one's. Counted only toward the window of
 * the record that session was authorized under.
 */
export interface PresenceWindowActivity {
  readonly approvedAt: number;
  readonly at: number;
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
   * verified a proof for `record` at `provedAt`. Replaces any entry for
   * another record outright.
   */
  seed(clientStaticPublicKey: string, record: PresenceWindowRecord, provedAt: number): void {
    this.#sweepCapped();
    this.#entries.set(clientStaticPublicKey, {
      accountId: record.accountId,
      passkeyCredentialId: record.passkeyCredentialId,
      passkeyPublicKeyHash: record.passkeyPublicKeyHash,
      approvedAt: record.approvedAt,
      provedAt,
      activeAt: provedAt,
    });
  }

  /** Fold one session's activity in; a no-op unless it was under the entry's record. */
  noteActivity(clientStaticPublicKey: string, activity: PresenceWindowActivity): void {
    const entry = this.#entries.get(clientStaticPublicKey);
    if (!entry || entry.approvedAt !== activity.approvedAt || activity.at <= entry.activeAt) return;
    this.#entries.set(clientStaticPublicKey, { ...entry, activeAt: activity.at });
  }

  /**
   * The open window for one Client static, or `null`. `live` is the activity
   * of a session still running under it, which has not been folded in yet.
   * Open means less than {@link PRESENCE_WINDOW_IDLE_MS} since the latest
   * activity and less than {@link PRESENCE_WINDOW_MAX_MS} since the proof.
   */
  open(clientStaticPublicKey: string, live: PresenceWindowActivity | null = null): PresenceWindowEntry | null {
    const entry = this.#entries.get(clientStaticPublicKey);
    if (!entry) return null;
    const now = this.#now();
    const liveAt = live?.approvedAt === entry.approvedAt ? live.at : Number.NEGATIVE_INFINITY;
    const activeAt = Math.max(entry.activeAt, liveAt);
    if (now - activeAt < PRESENCE_WINDOW_IDLE_MS && now - entry.provedAt < PRESENCE_WINDOW_MAX_MS) {
      return entry;
    }
    this.#entries.delete(clientStaticPublicKey);
    return null;
  }

  forget(clientStaticPublicKey: string): void {
    this.#entries.delete(clientStaticPublicKey);
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

/**
 * Setup tokens: the credential behind a Burrow's QR (`docs/specs/relay.md` →
 * "HTTP API", `POST /api/burrow/setup-token`).
 *
 * Relay-local rather than a `ChallengeIssuer` because the entry has to
 * remember WHICH Burrow minted it — a revoked Burrow's outstanding tokens die with
 * it, at every gate — and the issuer stores only an expiry.
 */

import { randomBytes } from 'node:crypto';

import { MAX_TOKENS_PER_BURROW, SETUP_TOKEN_TTL_MS, toBase64Url } from 'remote-lib-common';

// `MAX_TOKENS_PER_BURROW` bounds this map, which anything holding a `burrowToken`
// can otherwise grow for the process's lifetime by re-rendering its QR in a
// loop. Per-burrow rather than global: a global cap makes one Burrow's minting loop
// evict another Burrow's live token mid-scan, and a Burrow's own oldest goes first.
// It is defined in `remote-lib-common` because the Burrow caps its own invitation
// map at the same number.

/** 256 bits, like every other unguessable handle in this system. */
const SETUP_TOKEN_BYTE_LENGTH = 32;

export interface IssuedSetupToken {
  /** Base64url token bytes; also the handle used to peek/consume it. */
  readonly token: string;
  readonly expiresAt: number;
}

export interface SetupTokenIssuerOptions {
  /** Clock returning epoch milliseconds; injectable for tests. */
  readonly now?: () => number;
}

/** What a live token resolves to: the Burrow that minted it, and when it dies. */
export interface SetupTokenEntry {
  readonly burrowId: string;
  readonly expiresAt: number;
}

/**
 * Where a token is in its one use. `claimed`: a `finish` has spent it and is
 * still validating, so it may yet be restored. `committed`: that finish has
 * reached its registration write, so the token is spent for good unless the
 * write fails. Both stay in the map, so a retire can still reach them.
 */
type SetupTokenState = 'live' | 'claimed' | 'committed';

interface SetupTokenSlot {
  readonly entry: SetupTokenEntry;
  state: SetupTokenState;
}

export class SetupTokenIssuer {
  readonly #tokens = new Map<string, SetupTokenSlot>();
  readonly #now: () => number;

  constructor(options: SetupTokenIssuerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** Mint a token for `burrowId`, pruning first so the map cannot only grow. */
  issue(burrowId: string): IssuedSetupToken {
    this.#prune(burrowId);
    const token = toBase64Url(randomBytes(SETUP_TOKEN_BYTE_LENGTH));
    const expiresAt = this.#now() + SETUP_TOKEN_TTL_MS;
    this.#tokens.set(token, { entry: { burrowId, expiresAt }, state: 'live' });
    return { token, expiresAt };
  }

  /**
   * Resolve `token` WITHOUT spending it, or `null` when it is unknown, expired,
   * or claimed. `POST /api/setup/begin` checks the credential before the user
   * has done anything, so an abandoned registration must leave the QR on the
   * laptop screen still scannable; only `finish` calls {@link claim}.
   */
  peek(token: string): SetupTokenEntry | null {
    const slot = this.#live(token);
    return slot?.state === 'live' ? slot.entry : null;
  }

  /**
   * Spend `token` for a `finish`, answering its entry — or `null` when it is
   * unknown, expired, or already claimed. The finish then ends the claim with
   * exactly one of {@link settle} or {@link restore}.
   */
  claim(token: string): SetupTokenEntry | null {
    // This state change IS the concurrency gate for `POST /api/setup/finish`:
    // two finishes racing one token both reach here, and only the one that
    // finds it live claims it, so only one can register a passkey. Never carry
    // a burrowId peeked earlier past this point.
    const slot = this.#live(token);
    if (slot?.state !== 'live') return null;
    slot.state = 'claimed';
    return slot.entry;
  }

  /**
   * Mark a claimed token as about to register, immediately before the write:
   * false when a {@link retire}, the Burrow cap, or an expiry sweep killed it
   * while the finish validated, which must then register nothing.
   */
  commit(token: string): boolean {
    // Expiry is checked here too: no sweep may have run since the claim.
    const slot = this.#live(token);
    if (slot?.state !== 'claimed') return false;
    slot.state = 'committed';
    return true;
  }

  /** End a claim for good: the finish registered. */
  settle(token: string): void {
    this.#tokens.delete(token);
  }

  /**
   * End a claim by making the token redeemable again, on its original expiry
   * so a failed attempt cannot extend the shoulder-surf window. ONLY for the
   * failure paths of the `finish` that claimed it. A token killed meanwhile —
   * retired, evicted by the cap, or expired — stays dead: the claim never left
   * the map, so there is nothing to re-insert.
   */
  restore(token: string): void {
    const slot = this.#tokens.get(token);
    if (slot === undefined) return;
    if (this.#now() >= slot.entry.expiresAt) this.#tokens.delete(token);
    else slot.state = 'live';
  }

  /**
   * Kill `token` for a signed-in phone that will not register with it,
   * answering its entry — or `null` when it was already dead or spent. A
   * claimed token is killed too, so the finish holding it can neither register
   * nor restore it; a committed one is spent already, and dies either way.
   */
  retire(token: string): SetupTokenEntry | null {
    const slot = this.#live(token);
    if (slot === undefined) return null;
    this.#tokens.delete(token);
    return slot.state === 'committed' ? null : slot.entry;
  }

  /** `token`'s slot while unexpired; an expired one is reclaimed here. */
  #live(token: string): SetupTokenSlot | undefined {
    const slot = this.#tokens.get(token);
    if (slot === undefined) return undefined;
    if (this.#now() >= slot.entry.expiresAt) {
      // An expired entry can never become valid again.
      this.#tokens.delete(token);
      return undefined;
    }
    return slot;
  }

  /**
   * Drop expired tokens, then evict `burrowId`'s own oldest to leave one mint
   * slot. A claimed token counts and can be evicted: the cap is a kill like
   * any other, and the claim's restore then finds nothing.
   */
  #prune(burrowId: string): void {
    this.#pruneExpired();
    this.#trimBurrow(burrowId, MAX_TOKENS_PER_BURROW - 1);
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [token, { entry }] of this.#tokens) {
      if (now >= entry.expiresAt) this.#tokens.delete(token);
    }
  }

  /** Keep only `limit` outstanding tokens for one Burrow, oldest expiry first. */
  #trimBurrow(burrowId: string, limit: number): void {
    // Only this Burrow's rows are candidates, so a loop of mints cannot cost
    // another Burrow the token it is currently displaying.
    const own = [...this.#tokens]
      .filter(([, { entry }]) => entry.burrowId === burrowId)
      .sort((left, right) => left[1].entry.expiresAt - right[1].entry.expiresAt);
    for (let i = 0; i < own.length - limit; i++) {
      this.#tokens.delete(own[i]![0]);
    }
  }

  /** Outstanding tokens, for tests and the cap's own assertions. */
  get pendingCount(): number {
    return this.#tokens.size;
  }
}

/**
 * Setup tokens: the credential behind a Host's QR (`docs/specs/relay.md` →
 * "HTTP API", `POST /api/host/setup-token`).
 *
 * Relay-local rather than a `HostChallengeIssuer` because the entry has to
 * remember WHICH Host minted it — a revoked Host's outstanding tokens die with
 * it, at every gate — and the issuer stores only an expiry.
 */

import { randomBytes } from 'node:crypto';

import { DEFAULT_PAIRING_TTL_MS, MAX_TOKENS_PER_HOST, toBase64Url } from 'remote-lib-common';

export { MAX_TOKENS_PER_HOST };

/**
 * How long a minted token stays redeemable. It *is* `DEFAULT_PAIRING_TTL_MS`
 * because the two are one window from the user's side: the nonce the token
 * leaves behind rides into the pairing request, so it must outlive the passkey
 * ceremony that stands between scanning the QR and pairing.
 */
export const SETUP_TOKEN_TTL_MS = DEFAULT_PAIRING_TTL_MS;

// `MAX_TOKENS_PER_HOST` bounds this map, which anything holding a `hostToken`
// can otherwise grow for the process's lifetime by re-rendering its QR in a
// loop. Per-host rather than global: a global cap makes one Host's minting loop
// evict another Host's live token mid-scan, and a Host's own oldest goes first.
// It is defined in `remote-lib-common` because the Host caps its own invitation
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

/** What a live token resolves to: the Host that minted it, and when it dies. */
export interface SetupTokenEntry {
  readonly hostId: string;
  readonly expiresAt: number;
}

export class SetupTokenIssuer {
  readonly #tokens = new Map<string, SetupTokenEntry>();
  readonly #now: () => number;

  constructor(options: SetupTokenIssuerOptions = {}) {
    this.#now = options.now ?? (() => Date.now());
  }

  /** Mint a token for `hostId`, pruning first so the map cannot only grow. */
  issue(hostId: string): IssuedSetupToken {
    this.#prune(hostId);
    const token = toBase64Url(randomBytes(SETUP_TOKEN_BYTE_LENGTH));
    const expiresAt = this.#now() + SETUP_TOKEN_TTL_MS;
    this.#tokens.set(token, { hostId, expiresAt });
    return { token, expiresAt };
  }

  /**
   * Resolve `token` WITHOUT spending it, or `null` when it is unknown or
   * expired. `POST /api/setup/begin` checks the credential before the user has
   * done anything, so an abandoned registration must leave the QR on the laptop
   * screen still scannable; only `finish` calls {@link consume}.
   */
  peek(token: string): SetupTokenEntry | null {
    const entry = this.#tokens.get(token);
    if (entry === undefined) return null;
    if (this.#now() >= entry.expiresAt) {
      // Reclaim it here too; an expired entry can never become valid again.
      this.#tokens.delete(token);
      return null;
    }
    return entry;
  }

  /**
   * Spend `token`, answering its entry — or `null` when it is unknown or
   * expired. Removed either way, so it can never become valid again.
   */
  consume(token: string): SetupTokenEntry | null {
    // This delete IS the concurrency gate for `POST /api/setup/finish`: two
    // finishes racing one token both reach here, and only the one that finds
    // the entry spends it, so only one can register a passkey. Never carry a
    // hostId peeked earlier past this point.
    const entry = this.#tokens.get(token);
    if (entry === undefined) return null;
    this.#tokens.delete(token);
    return this.#now() < entry.expiresAt ? entry : null;
  }

  /**
   * Put a consumed token back, keeping its original expiry so restoring cannot
   * extend the shoulder-surf window. ONLY for the failure paths of the route
   * that consumed it — a `finish` that spends the token and then fails must
   * leave the QR scannable — never as a way to re-issue or refresh one. A mint
   * may have filled its old slot while validation awaited, so restoration
   * reapplies the Host cap before inserting it.
   */
  restore(token: string, entry: SetupTokenEntry): void {
    if (this.#now() >= entry.expiresAt) return;
    this.#tokens.delete(token);
    this.#pruneExpired();
    this.#trimHost(entry.hostId, MAX_TOKENS_PER_HOST - 1);
    this.#tokens.set(token, entry);
  }

  /**
   * Drop expired tokens, then evict `hostId`'s own oldest to leave one mint
   * slot. Restored entries re-enter out of issue order, so age is `expiresAt`
   * rather than Map insertion order.
   */
  #prune(hostId: string): void {
    this.#pruneExpired();
    this.#trimHost(hostId, MAX_TOKENS_PER_HOST - 1);
  }

  #pruneExpired(): void {
    const now = this.#now();
    for (const [token, entry] of this.#tokens) {
      if (now >= entry.expiresAt) this.#tokens.delete(token);
    }
  }

  /** Keep only `limit` live tokens for one Host, oldest expiry first. */
  #trimHost(hostId: string, limit: number): void {
    // Only this Host's rows are candidates, so a loop of mints cannot cost
    // another Host the token it is currently displaying.
    const own = [...this.#tokens]
      .filter(([, entry]) => entry.hostId === hostId)
      .sort((left, right) => left[1].expiresAt - right[1].expiresAt);
    for (let i = 0; i < own.length - limit; i++) {
      this.#tokens.delete(own[i]![0]);
    }
  }

  /** Outstanding tokens, for tests and the cap's own assertions. */
  get pendingCount(): number {
    return this.#tokens.size;
  }
}

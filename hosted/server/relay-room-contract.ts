// The contract between Hosted's Workers and the relay's `RelayRoom`
// (`docs/specs/hosted.md` -> "Relay sockets"): how an object is named, what an
// upgrade hands it, and the RPC either Worker may call. Apart from the object,
// so neither Worker's routes import it nor it theirs.

/**
 * The verified fields the relay Worker hands a `RelayRoom` with an upgrade, as
 * search parameters on a request it builds fresh: the account the token
 * named, and the Burrow's id or the session's expiry and token hash, the key
 * its sweep and `closeSessions` find the session by.
 */
export const RELAY_ROOM_PARAMS = {
  account: "account",
  burrowId: "burrow",
  expiresAt: "expires",
  session: "session",
} as const;

/**
 * The longest a `RelayRoom` holding a socket goes between re-reading its
 * Burrows' and Client sessions' rows: the backstop that closes a removed or
 * de-entitled Burrow, or a Client whose session was deleted or whose account
 * lost the entitlement, when no close arrived.
 */
export const RELAY_ROOM_SWEEP_MS = 60 * 60 * 1000;

/**
 * How soon a `RelayRoom` sweeps again after a sweep whose row read failed or
 * timed out, in place of `RELAY_ROOM_SWEEP_MS`.
 */
export const RELAY_ROOM_SWEEP_RETRY_MS = 60 * 1000;

/**
 * How long past `RELAY_ROOM_SWEEP_MS` a held socket may go without a row read
 * that found it live before a failed sweep closes it 1013, to reconnect
 * through the upgrade's own recheck: the database outage a live session rides
 * out, and so the most a removal's backstop slips while the rows are unreadable.
 */
export const RELAY_ROOM_SWEEP_GRACE_MS = 10 * 60 * 1000;

/**
 * The longest a `RelayRoom` waits on a read of its rows before
 * treating it as failed: well under the 30 s after which the runtime resets
 * an object whose `blockConcurrencyWhile` callback has not settled.
 */
export const RELAY_ROW_READ_TIMEOUT_MS = 5_000;

/** The RPC a `RelayRoom` serves. Each names the account, which the object checks against its own. */
export interface RelayRoomRpc {
  /** Close `burrowId`'s socket as revoked (4001), its Clients told `burrow-gone`; whether one was held. */
  closeBurrow(account: string, burrowId: string): Promise<boolean>;
  /** Close every Client socket opened by a session hashed `tokenHashes` as unauthorized (1008), each Burrow told `client-gone`; how many. */
  closeSessions(account: string, tokenHashes: string[]): Promise<number>;
  /** Every Burrow holding a live socket: what `GET /api/burrows` reports online. */
  onlineBurrows(account: string): Promise<string[]>;
}

/** The account's `RelayRoom`, named from its user id and nothing else, its RPC bound to that account. */
export function relayRoom(namespace: DurableObjectNamespace<RelayRoomRpc>, account: string) {
  const stub = namespace.get(namespace.idFromName(account));
  return {
    fetch: (request: Request) => stub.fetch(request),
    closeBurrow: (burrowId: string) => stub.closeBurrow(account, burrowId),
    closeSessions: (tokenHashes: string[]) => stub.closeSessions(account, tokenHashes),
    onlineBurrows: () => stub.onlineBurrows(account),
  };
}

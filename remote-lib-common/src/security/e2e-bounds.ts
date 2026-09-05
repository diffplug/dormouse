/**
 * The bounds an end-to-end session lives inside.
 *
 * Every one is Burrow-enforced and independent of the relay; what each means and
 * why it is where it is belongs to `docs/specs/remote-security-model.md` ->
 * Burrow bounds. They live together — rather than inside the Burrow — because two
 * of them are the Client's business too: the Burrow reaps on the idle timeout and
 * the Client keepalives against it, so two copies would be two opinions about
 * when a live session looks dead. The pending-ceremony caps stay beside the
 * work they bound: `MAX_PENDING_PAIRINGS` in `pairing.ts`,
 * `MAX_PENDING_CONNECTION_HANDSHAKES` in the Burrow itself.
 *
 * The relationships between these numbers are pinned by
 * `remote-lib-common/test/e2e-bounds.test.mjs`; what the Burrow does with them is
 * `lib/src/remote/burrow/burrow-bounds.test.ts`.
 */

/** How many authorized sessions one Burrow will hold at once. */
export const MAX_ESTABLISHED_E2E_SESSIONS = 16;

/**
 * How often a Client sends a keepalive on an established session, while its
 * page is visible. Fixed-size, so the interval leaks nothing a timing observer
 * did not already have.
 */
export const E2E_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * How long an established session may go without a successfully decrypted
 * Client->Burrow message before the Burrow disposes it.
 *
 * Four keepalive intervals: a phone that misses one to a radio gap or a
 * garbage-collected timer is still inside the window, and one suspended in the
 * background is not.
 */
export const ESTABLISHED_E2E_IDLE_TIMEOUT_MS = 120_000;

/**
 * The Burrow's crypto token bucket: how many `init` frames may be answered back
 * to back before the sustained rate applies.
 *
 * Eight, the pending-ceremony caps' own number — a burst larger than the
 * number of handshakes that can be pending buys an attacker nothing but
 * WebCrypto work.
 */
export const E2E_INIT_BURST = 8;

/** One token back per second: the sustained rate that burst decays to. */
export const E2E_INIT_REFILL_INTERVAL_MS = 1_000;

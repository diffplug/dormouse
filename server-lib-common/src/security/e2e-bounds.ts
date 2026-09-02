/**
 * The bounds an end-to-end session lives inside, shared because both endpoints
 * have to agree on them: the Host reaps on the idle timeout and the Client
 * sends keepalives against the same clock, so two copies would be two opinions
 * about when a live session looks dead.
 *
 * Every one is **Host-enforced and independent of the relay**
 * (`docs/specs/remote-security-model.md` -> Host bounds); the Server's own
 * gates are defense in depth. The pending-ceremony caps live beside the work
 * they bound — `MAX_PENDING_PAIRINGS` in `pairing.ts`,
 * `MAX_PENDING_CONNECTION_HANDSHAKES` in the Host itself.
 */

/**
 * How many authorized sessions one Host will hold at once.
 *
 * Checked only at promotion, after the presence proof and the ACL conjunction
 * have already succeeded: a cap applied earlier would let unauthenticated
 * traffic decide who gets in. A Client static that already holds a session
 * replaces its own; a different identity at the cap is answered `host-busy`
 * and evicts nobody, because an authorized phone must not be displaceable by a
 * stranger who merely completed a handshake.
 */
export const MAX_ESTABLISHED_E2E_SESSIONS = 16;

/**
 * How often a Client sends a keepalive on an established session, while its
 * page is visible. Fixed-size, so the interval leaks nothing a timing observer
 * did not already have.
 */
export const E2E_KEEPALIVE_INTERVAL_MS = 30_000;

/**
 * How long an established session may go without a successfully decrypted
 * Client->Host message before the Host disposes it.
 *
 * Four keepalive intervals: a phone that misses one to a radio gap or a
 * garbage-collected timer is still inside the window, and one suspended in the
 * background is not. Nothing else refreshes it — not Host output, not a relay
 * envelope, not a socket ping — because only an authenticated Client frame is
 * evidence the paired phone is still there.
 */
export const ESTABLISHED_E2E_IDLE_TIMEOUT_MS = 120_000;

/**
 * The Host's crypto token bucket: how many `init` frames may be answered back
 * to back before the sustained rate applies.
 *
 * Eight, the pending-ceremony caps' own number — a burst larger than the
 * number of handshakes that can be pending buys an attacker nothing but
 * WebCrypto work.
 */
export const E2E_INIT_BURST = 8;

/** One token back per second: the sustained rate that burst decays to. */
export const E2E_INIT_REFILL_INTERVAL_MS = 1_000;

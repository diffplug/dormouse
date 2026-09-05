/**
 * Code shared between the frontend (`lib`) and the backend (`relay`) — the
 * Relay-side counterpart to `dor-lib-common`.
 *
 * Keep this package runtime-agnostic: it is compiled into both a browser bundle
 * (via `lib`) and a Node process (`relay`), so it must not reach for Node or
 * DOM globals. That is why `tsconfig.json` sets `"types": []`.
 *
 * The `security/` modules implement the primitives of
 * `docs/specs/remote-security-model.md`: the Noise suite and its transport
 * framing, presence proofs, pairing invitations, the two ceremonies' control
 * messages, burrow challenges, passkey assertion verification, and the Burrow ACL.
 */

export * from './remote/wire.js';
export * from './remote/enroll-offer.js';
export * from './remote/origin.js';
export * from './security/webcrypto.js';
export * from './security/bytes.js';
export * from './security/ecdsa.js';
export * from './security/noise.js';
export * from './security/noise-transport.js';
export * from './security/presence.js';
export * from './security/challenge.js';
export * from './security/passkey.js';
export * from './security/acl.js';
export * from './security/push.js';
export * from './security/push-seal.js';
export * from './security/pairing.js';
export * from './security/e2e-bounds.js';
export * from './security/token-bucket.js';
export * from './security/pairing-invitation.js';
export * from './security/e2e-ceremony.js';

/**
 * The one thing both halves of the E2E harness must agree on: which prologue a
 * ceremony binds. Shared so the fake Client and the fake Host cannot drift into
 * two opinions about the transcript — a drift that would show up as a decrypt
 * failure and read like a bug in the suite.
 */

import { randomBytes } from 'node:crypto';

import { e2eConnectionPrologue, e2ePairingPrologue, toBase64Url } from 'server-lib-common';

/**
 * The prologue for one ceremony: the E2E version, the kind, the `hostId`, and —
 * for a connection — the connection id.
 *
 * Pairing binds no extra field yet. The invitation (its id, expiry, setup
 * token, and one-use public key) lands with the pairing ceremony in stage 4 of
 * **Scope: e2e-client-host**, which fills in `e2ePairingPrologue`'s field list.
 */
export function e2ePrologueFor({ kind, hostId, id }) {
  return kind === 'connection' ? e2eConnectionPrologue(hostId, id) : e2ePairingPrologue(hostId, []);
}

/** A fresh routing id: base64url of 16 bytes, the length the envelope pins. */
export function newE2eId() {
  return toBase64Url(randomBytes(16));
}

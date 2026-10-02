/**
 * The envelope facts every E2E test shares, whichever Relay it drives: which
 * prologue a ceremony binds, what a well-formed `e2e` frame looks like on each
 * side of the relay, and the pair-then-connect walk a transport case starts
 * from. Shared so the fake Client and the fake Burrow cannot drift into two
 * opinions about the transcript — a drift that would show up as a decrypt
 * failure and read like a bug in the suite — and so a change to the envelope
 * is one edit.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  E2E_ID_BYTE_LENGTH,
  e2eConnectionPrologue,
  e2ePairingPrologue,
  fromBase64Url,
  toBase64Url,
} from '../../dist/index.js';

/**
 * The prologue for one ceremony: the E2E version, the kind, the `burrowId`, and —
 * for a connection — the connection id.
 *
 * The low-level door only: a real pairing binds every invitation field through
 * `pairingInvitationPrologue`, which both halves of the harness call directly.
 * The empty field list here is what a transcript-binding test wants — a
 * prologue neither side's ceremony would ever build.
 */
export function e2ePrologueFor({ kind, burrowId, id }) {
  return kind === 'connection' ? e2eConnectionPrologue(burrowId, id) : e2ePairingPrologue(burrowId, []);
}

/** A fresh routing id, minted at the one length `isE2eId` accepts. */
export function newE2eId() {
  return toBase64Url(randomBytes(E2E_ID_BYTE_LENGTH));
}

/**
 * A well-formed Client-originated `e2e` frame; the relay never decodes `ct`.
 * `overrides` is how a test malforms exactly one field.
 */
export function e2eClientFrame(burrowId, overrides = {}) {
  return { t: 'e2e', burrowId, kind: 'pairing', id: newE2eId(), step: 'init', ct: 'Zm9v', ...overrides };
}

/** Its Burrow-originated twin, addressed to `clientId` and carrying no `burrowId`. */
export function e2eBurrowFrame(clientId, overrides = {}) {
  return {
    t: 'e2e',
    clientId,
    kind: 'pairing',
    id: newE2eId(),
    step: 'response',
    ct: 'YmFy',
    ...overrides,
  };
}

/**
 * Pair and connect a fixture's Client, leaving an authorized session. The
 * fixture names the account its Relay answers (`'owner'` on the self-host
 * Relay, the user id on Hosted) as `accountId`, or leaves it to the Client's
 * default.
 *
 * The transport cases ride one, because that is where a Client's traffic
 * actually lives: on a *pending* connection the Burrow answers the first control
 * with an outcome and stops, exactly as `BurrowRuntime` does.
 */
export async function establish(fixture) {
  const invitation = await fixture.burrow.mintInvitation();
  const paired = await fixture.client.pair({
    invitation,
    authenticator: fixture.authenticator,
    ...(fixture.accountId !== undefined && { accountId: fixture.accountId }),
  });
  assert.equal(paired.ok, true, JSON.stringify(paired.outcome));
  // The account rides in from the pairing outcome the Client kept.
  const connected = await fixture.client.connect({ authenticator: fixture.authenticator });
  assert.equal(connected.ok, true, JSON.stringify(connected.outcome));
  return connected;
}

/** Record the Burrow's e2e outcomes so a test can await one. */
export function watch(burrow) {
  const receipts = [];
  const errors = [];
  const opens = [];
  burrow.on('e2e-receive', (ev) => receipts.push(ev));
  burrow.on('e2e-error', (ev) => errors.push(ev));
  burrow.on('e2e-open', (ev) => opens.push(ev));
  return { receipts, errors, opens };
}

/** Flip one byte of a base64url ciphertext — what a hostile relay looks like. */
export function flip(ct, index = -1) {
  const bytes = fromBase64Url(ct);
  const at = index < 0 ? bytes.length + index : index;
  bytes[at] ^= 0x01;
  return toBase64Url(bytes);
}

/**
 * The envelope facts every E2E test shares: which prologue a ceremony binds,
 * and what a well-formed `e2e` frame looks like on each side of the relay.
 * Shared so the fake Client and the fake Host cannot drift into two opinions
 * about the transcript — a drift that would show up as a decrypt failure and
 * read like a bug in the suite — and so a change to the envelope is one edit.
 */

import { randomBytes } from 'node:crypto';

import {
  E2E_ID_BYTE_LENGTH,
  e2eConnectionPrologue,
  e2ePairingPrologue,
  toBase64Url,
} from 'server-lib-common';

/**
 * The prologue for one ceremony: the E2E version, the kind, the `hostId`, and —
 * for a connection — the connection id.
 *
 * The low-level door only: a real pairing binds every invitation field through
 * `pairingInvitationPrologue`, which both halves of the harness call directly.
 * The empty field list here is what a transcript-binding test wants — a
 * prologue neither side's ceremony would ever build.
 */
export function e2ePrologueFor({ kind, hostId, id }) {
  return kind === 'connection' ? e2eConnectionPrologue(hostId, id) : e2ePairingPrologue(hostId, []);
}

/** A fresh routing id, minted at the one length `isE2eId` accepts. */
export function newE2eId() {
  return toBase64Url(randomBytes(E2E_ID_BYTE_LENGTH));
}

/**
 * A well-formed Client-originated `e2e` frame; the relay never decodes `ct`.
 * `overrides` is how a test malforms exactly one field.
 */
export function e2eClientFrame(hostId, overrides = {}) {
  return { t: 'e2e', hostId, kind: 'pairing', id: newE2eId(), step: 'init', ct: 'Zm9v', ...overrides };
}

/** Its Host-originated twin, addressed to `clientId` and carrying no `hostId`. */
export function e2eHostFrame(clientId, overrides = {}) {
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

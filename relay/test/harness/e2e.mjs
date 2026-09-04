/**
 * The envelope facts every E2E test shares: which prologue a ceremony binds,
 * and what a well-formed `e2e` frame looks like on each side of the relay.
 * Shared so the fake Client and the fake Host cannot drift into two opinions
 * about the transcript — a drift that would show up as a decrypt failure and
 * read like a bug in the suite — and so a change to the envelope is one edit.
 */

import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import {
  E2E_ID_BYTE_LENGTH,
  e2eConnectionPrologue,
  e2ePairingPrologue,
  fromBase64Url,
  generateNoiseKeyPair,
  toBase64Url,
} from 'remote-lib-common';

import { enrollHost, freshApp, ownerSession, startRelay } from '../helpers.mjs';
import { FakeClient } from './fake-client.mjs';
import { FakeHost } from './fake-host.mjs';

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

/**
 * A live Relay, one Host with a Noise static, and one Client that pins it.
 *
 * `relayFor` — `(hostId) => relay` — puts a peer the test controls between the
 * two halves (`./malicious-relay.mjs`); without it both open real sockets to
 * the Relay's own relay. A factory because the relay binds the `hostId` this
 * fixture only learns at enrollment. Shared so the honest and hostile suites
 * cannot drift into two fixtures — the difference between them has to be the
 * relay and nothing else.
 */
export async function e2eFixture({ relayFor } = {}) {
  const created = await freshApp();
  const server = await startRelay(created);
  const { body: enrollment } = await enrollHost(created.app);
  const relay = relayFor ? relayFor(enrollment.hostId) : null;
  const hostStatic = await generateNoiseKeyPair();
  const clientStatic = await generateNoiseKeyPair();
  const host = new FakeHost({
    relayUrl: server.wsUrl,
    hostToken: enrollment.hostToken,
    hostId: enrollment.hostId,
    origin: created.origin,
    rpId: created.rpId,
    noiseStaticKeyPair: hostStatic,
    socket: relay?.hostSocket,
  });
  await host.ready;
  const { sessionToken, authenticator } = await ownerSession(created.app);
  const client = new FakeClient({
    relayUrl: server.wsUrl,
    sessionToken,
    hostId: enrollment.hostId,
    staticKeyPair: clientStatic,
    hostStaticPublicKey: hostStatic.publicKey,
    origin: created.origin,
    rpId: created.rpId,
    socket: relay?.clientSocket,
  });
  await client.ready;
  const opened = [host, client];
  return {
    app: created.app,
    server,
    host,
    client,
    relay,
    authenticator,
    enrollment,
    hostStatic,
    clientStatic,
    /** A second Host socket for the same enrollment — models a Host restart. */
    async replacementHost() {
      const replacement = new FakeHost({
        relayUrl: server.wsUrl,
        hostToken: enrollment.hostToken,
        hostId: enrollment.hostId,
        origin: created.origin,
        rpId: created.rpId,
        noiseStaticKeyPair: hostStatic,
      });
      await replacement.ready;
      opened.push(replacement);
      return replacement;
    },
    async secondHost() {
      const { body } = await enrollHost(created.app);
      const second = new FakeHost({
        relayUrl: server.wsUrl,
        hostToken: body.hostToken,
        hostId: body.hostId,
        origin: created.origin,
        rpId: created.rpId,
        noiseStaticKeyPair: hostStatic,
      });
      await second.ready;
      opened.push(second);
      return second;
    },
    close: async () => {
      for (const conn of opened) conn.close();
      relay?.close();
      await server.close();
    },
  };
}

/**
 * Pair and connect this fixture's Client, leaving an authorized session.
 *
 * The transport cases ride one, because that is where a Client's traffic
 * actually lives: on a *pending* connection the Host answers the first control
 * with an outcome and stops, exactly as `RemoteHost` does.
 */
export async function establish(fixture) {
  const invitation = await fixture.host.mintInvitation();
  const paired = await fixture.client.pair({
    invitation,
    authenticator: fixture.authenticator,
  });
  assert.equal(paired.ok, true, JSON.stringify(paired.outcome));
  const connected = await fixture.client.connect({ authenticator: fixture.authenticator });
  assert.equal(connected.ok, true, JSON.stringify(connected.outcome));
  return connected;
}

/** Record the Host's e2e outcomes so a test can await one. */
export function watch(host) {
  const receipts = [];
  const errors = [];
  const opens = [];
  host.on('e2e-receive', (ev) => receipts.push(ev));
  host.on('e2e-error', (ev) => errors.push(ev));
  host.on('e2e-open', (ev) => opens.push(ev));
  return { receipts, errors, opens };
}

/** Flip one byte of a base64url ciphertext — what a hostile relay looks like. */
export function flip(ct, index = -1) {
  const bytes = fromBase64Url(ct);
  const at = index < 0 ? bytes.length + index : index;
  bytes[at] ^= 0x01;
  return toBase64Url(bytes);
}

/**
 * A headless Node Host (Dormouse Terminal) for exercising the relay end to end.
 *
 * Its `e2e` half mirrors `RemoteHost` (`lib/src/remote/host/remote-host.ts`)
 * over the same shared primitives — invitations and the pairing IK responder,
 * `verifyPresenceProof`, the reverse two-digit confirmation, `HostAcl`, the
 * connection responder with its `HostChallengeIssuer` payload, and the
 * four-way ACL conjunction — so a test cannot pass against behavior the real
 * Host lacks. Everything is in memory, so a fresh instance (reconnecting with
 * the same token) models a Host restart: its ACL starts empty again.
 *
 * Constructor: `{ relayUrl, hostToken, hostId, origin, rpId, label,
 * autoApprove, requireUserVerification, noiseStaticKeyPair }`. `relayUrl` may
 * be `http(s)://…` or `ws(s)://…`. With `autoApprove` the Host types back
 * whatever code the request displayed; otherwise call
 * `confirmPairing(clientId, code)` / `denyPairing(clientId)`.
 *
 * Events, for logs and assertions: `open`, `close`, `frame`, `invitation`,
 * `e2e-open`, `e2e-receive`, `e2e-error`, `pairing-request`, `paired`,
 * `denied`, `decision`, `msg`, `client-gone`.
 */

import { EventEmitter } from 'node:events';

import {
  DEFAULT_PAIRING_TTL_MS,
  DELIVERY_ID_BYTE_LENGTH,
  HostAcl,
  HostChallengeIssuer,
  MAX_TOKENS_PER_HOST,
  NoiseTransportSession,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  boundedPairingLabel,
  clampTerminalDimension,
  constantTimeEqual,
  createNoiseResponder,
  e2eConnectionPrologue,
  formatInvitationExpiry,
  fromBase64Url,
  generateNoiseKeyPair,
  isConnectionRequestV1,
  isE2eRelayToHostFrame,
  isPairingRequestV1,
  pairingInvitationPrologue,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  verifyPresenceProof,
} from 'remote-lib-common';

import { attachFrameSocket, closeSocket, receiveFrame, sendFrame } from './frame-socket.mjs';

/** Base64url of `count` random bytes — routing ids, setup tokens, delivery ids. */
function randomBase64Url(count) {
  return toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(count)));
}

export class FakeHost extends EventEmitter {
  /** Frames from this socket are handled one at a time, in arrival order. */
  #chain = Promise.resolve();

  constructor({
    relayUrl,
    hostToken,
    hostId,
    origin,
    rpId,
    label = 'Fake Laptop',
    autoApprove = true,
    requireUserVerification,
    noiseStaticKeyPair,
    socket,
  }) {
    super();
    this.hostId = hostId;
    this.label = label;
    this.autoApprove = autoApprove;
    this.noiseStaticKeyPair = noiseStaticKeyPair;
    /** The long-term static a paired Client pins; handed out in every success. */
    this.staticPublicKey = noiseStaticKeyPair ? toBase64Url(noiseStaticKeyPair.publicKey) : '';
    this.policy = { rpId, origin, requireUserVerification };
    this.acl = new HostAcl(hostId);
    this.challenges = new HostChallengeIssuer();
    /** inviteId → `{ invitation, keyPair, expiresAt, state }`; the key lives only here. */
    this.invitations = new Map();
    /** clientId → `{ pairing?, connection?, established? }`, so teardown is one delete. */
    this.clients = new Map();

    /**
     * A tiny synthetic terminal directory so the remote adapter is testable
     * without a real Host: two in-memory "echo shells" addressable by surfaceId.
     */
    this.surfaces = [
      { surfaceId: 'srf-zsh', paneRef: 'pane-zsh', title: 'zsh', cols: 80, rows: 24 },
      { surfaceId: 'srf-vim', paneRef: 'pane-vim', title: 'vim', cols: 80, rows: 24 },
    ];
    /** clientId → directory-watch subId (the request id it was opened with). */
    this.directorySubs = new Map();
    /** clientId → { surfaceId, subId } for the one attached surface, if any. */
    this.attachments = new Map();

    const wsBase = relayUrl.replace(/^http/, 'ws');
    const ws = attachFrameSocket(
      this,
      `${wsBase}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${hostToken}`,
      socket,
    );
    ws.addEventListener('message', (ev) => {
      // Serialized through a promise chain for the reason the relay serializes
      // its client socket (`relay/src/app.ts`): every `e2e` step awaits
      // WebCrypto, so unchained handlers would let a pipelined `transport`
      // overtake the `init` that has to create its session.
      this.#chain = this.#chain.then(() => this.#onFrame(ev.data)).catch(() => undefined);
    });
  }

  #send(frame) {
    sendFrame(this, frame);
  }

  async #onFrame(raw) {
    const frame = receiveFrame(this, raw);
    if (!frame) return;
    if (frame.t === 'e2e') {
      // Handled before the clientId narrowing below: it runs the wire guard
      // itself, which bounds `clientId` more tightly than that check does.
      await this.#onE2e(frame);
      return;
    }
    if (frame.t !== 'client-gone') return;
    if (typeof frame.clientId !== 'string') return;
    this.directorySubs.delete(frame.clientId);
    this.attachments.delete(frame.clientId);
    this.#disposeClient(frame.clientId);
    this.emit('client-gone', { clientId: frame.clientId });
  }

  // --- Invitations ----------------------------------------------------------

  /**
   * Mint one invitation for a setup QR: a 16-byte id, a one-use X25519
   * responder keypair, and the expiry the code advertises. The setup token is
   * the caller's — a real one from `POST /api/host/setup-token` when the test
   * cares that redemption and pairing share a credential.
   *
   * Prunes on insert (nothing else sweeps this map) and evicts its own oldest
   * at {@link MAX_TOKENS_PER_HOST}, the Relay's bound on the tokens these ride
   * with, so the two sides agree on live-versus-spent.
   */
  async mintInvitation({
    setupToken = randomBase64Url(32),
    expiresAt = Date.now() + DEFAULT_PAIRING_TTL_MS,
  } = {}) {
    this.#reapInvitations();
    while (this.invitations.size >= MAX_TOKENS_PER_HOST) {
      const oldest = this.invitations.keys().next();
      if (oldest.done) break;
      // Unstated, so the entry's own state decides — as `RemoteHost` does.
      this.#retireInvitation(oldest.value);
    }
    const keyPair = await generateNoiseKeyPair();
    const invitation = {
      hostId: this.hostId,
      inviteId: randomBase64Url(16),
      expiry: Math.floor(expiresAt / 1000),
      setupToken,
      ephPub: keyPair.publicKey,
      ephPubBase64Url: toBase64Url(keyPair.publicKey),
    };
    // Throws on a non-uint32 expiry before anything is stored.
    formatInvitationExpiry(invitation.expiry);
    this.invitations.set(invitation.inviteId, { invitation, keyPair, expiresAt, state: 'live' });
    return invitation;
  }

  /** `live`, `reserved`, or `consumed` for an id this Host no longer holds. */
  invitationState(inviteId) {
    const held = this.invitations.get(inviteId);
    if (!held) return 'consumed';
    return held.expiresAt <= Date.now() ? 'expired' : held.state;
  }

  #reapInvitations() {
    const now = Date.now();
    for (const [inviteId, held] of this.invitations) {
      if (held.expiresAt <= now) this.#retireInvitation(inviteId, 'expired');
    }
  }

  /**
   * Mirrors `RemoteHost.#retireInvitation`: with no `state` the entry's own
   * decides it, so an evicted code a phone had already scanned reports
   * `consumed` and one nobody touched reports `dropped`.
   */
  #retireInvitation(inviteId, state) {
    const held = this.invitations.get(inviteId);
    if (!held) return;
    this.invitations.delete(inviteId);
    this.emit('invitation', {
      inviteId,
      state: state ?? (held.state === 'reserved' ? 'consumed' : 'dropped'),
    });
  }

  // --- The `e2e` envelope ---------------------------------------------------

  #clientState(clientId) {
    let state = this.clients.get(clientId);
    if (!state) {
      state = {};
      this.clients.set(clientId, state);
    }
    return state;
  }

  #pruneClient(clientId) {
    const state = this.clients.get(clientId);
    if (state && !state.pairing && !state.connection && !state.established) {
      this.clients.delete(clientId);
    }
  }

  #disposeClient(clientId) {
    const state = this.clients.get(clientId);
    if (!state) return;
    if (state.pairing) this.#retireInvitation(state.pairing.id, 'consumed');
    this.clients.delete(clientId);
  }

  async #onE2e(frame) {
    if (!isE2eRelayToHostFrame(frame)) {
      this.emit('e2e-error', { error: new Error('malformed e2e frame'), frame });
      return;
    }
    this.#reapInvitations();
    if (frame.kind === 'pairing') {
      if (frame.step === 'init') return await this.#onPairingInit(frame);
      return await this.#onPairingTransport(frame);
    }
    if (frame.step === 'init') return await this.#onConnectionInit(frame);
    return await this.#onConnectionTransport(frame);
  }

  /** The entry a test addresses this client by: newest live ceremony first. */
  e2eEntry(clientId) {
    const state = this.clients.get(clientId);
    return state?.established ?? state?.connection ?? state?.pairing;
  }

  /** Wrap one ciphertext this Host produced in a transport frame. */
  e2eSendCiphertext(entry, ciphertext) {
    this.#send({
      t: 'e2e',
      clientId: entry.clientId,
      kind: entry.kind,
      id: entry.id,
      step: 'transport',
      ct: typeof ciphertext === 'string' ? ciphertext : toBase64Url(ciphertext),
    });
  }

  e2eSendApp(clientId, bytes) {
    const entry = this.e2eEntry(clientId);
    const ciphertexts = entry.session.sendApp(bytes);
    for (const ciphertext of ciphertexts) this.e2eSendCiphertext(entry, ciphertext);
    return ciphertexts.length;
  }

  /**
   * One control message on a ceremony session. Every outcome — approval and
   * denial alike — is the same NUL-padded size, so the relay learns nothing
   * from a length.
   */
  #sendControl(entry, value) {
    let ciphertext;
    try {
      ciphertext = entry.session.sendControl(value);
    } catch {
      return; // a poisoned session has nothing to say
    }
    this.e2eSendCiphertext(entry, ciphertext);
  }

  // --- Pairing --------------------------------------------------------------

  /**
   * Noise message 1 against one invitation's key. A frame naming an invitation
   * this Host does not hold live is dropped without decryption — an unknown id
   * must cost a map lookup, not a handshake.
   */
  async #onPairingInit(frame) {
    const held = this.invitations.get(frame.id);
    if (!held || held.state !== 'live') return;
    let entry;
    try {
      const handshake = await createNoiseResponder({
        prologue: pairingInvitationPrologue(held.invitation),
        staticKeyPair: held.keyPair,
      });
      const payload = await handshake.readMessage(fromBase64Url(frame.ct));
      // Both handshake payloads are empty; anything else is a peer this Host
      // does not speak the same protocol as.
      if (payload.length !== 0) throw new Error('pairing message 1 carries a payload');
      const message2 = await handshake.writeMessage();
      const remoteStatic = handshake.remoteStaticPublicKey;
      if (!remoteStatic) throw new Error('IK did not authenticate a Client static');
      const session = new NoiseTransportSession(handshake.session);
      entry = {
        clientId: frame.clientId,
        kind: 'pairing',
        id: frame.id,
        session,
        handshakeHash: toBase64Url(session.handshakeHash),
        clientStaticPublicKey: toBase64Url(remoteStatic),
        message2,
        attempted: false,
      };
    } catch (error) {
      // The invitation stays live: nothing decrypted against it, so no scanner
      // has been spent — only a valid message 1 reserves one.
      this.emit('e2e-error', { clientId: frame.clientId, kind: 'pairing', id: frame.id, error, frame });
      return;
    }
    const state = this.#clientState(frame.clientId);
    if (state.pairing) this.#finishPairing(frame.clientId, 'superseded');
    held.state = 'reserved';
    this.emit('invitation', { inviteId: frame.id, state: 'reserved' });
    this.#clientState(frame.clientId).pairing = entry;
    this.#send({
      t: 'e2e',
      clientId: frame.clientId,
      kind: 'pairing',
      id: frame.id,
      step: 'response',
      ct: toBase64Url(entry.message2),
    });
    this.emit('e2e-open', entry);
  }

  /**
   * The first Client→Host transport payload of a pairing: a `PairingRequestV1`
   * carrying the two digits, the device label, and the presence proof. Anything
   * else is terminal — the invitation is single-use and the person at the Host
   * is about to be interrupted.
   */
  async #onPairingTransport(frame) {
    const pending = this.clients.get(frame.clientId)?.pairing;
    if (!pending || pending.id !== frame.id) return;
    let receipt;
    try {
      receipt = pending.session.receive(fromBase64Url(frame.ct));
    } catch (error) {
      // The first invalid ciphertext destroys its session; nothing can be said
      // over a poisoned one.
      this.emit('e2e-error', { clientId: frame.clientId, kind: 'pairing', id: frame.id, error, frame });
      return;
    }
    this.emit('e2e-receive', {
      clientId: frame.clientId,
      kind: 'pairing',
      id: frame.id,
      receipt,
      entry: pending,
    });
    if (receipt.kind === 'keepalive') return;
    if (pending.approval) return; // already surfaced; further traffic is noise
    if (receipt.kind !== 'control' || !isPairingRequestV1(receipt.value)) {
      this.#finishPairing(frame.clientId, 'host-error');
      return;
    }
    const request = receipt.value;
    const binding = {
      kind: 'pairing',
      hostId: this.hostId,
      handshakeHash: pending.handshakeHash,
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, binding, this.policy);
    // The client may have gone, or been superseded, while WebCrypto ran.
    if (this.clients.get(frame.clientId)?.pairing !== pending) return;
    if (!proof.ok) {
      this.#finishPairing(frame.clientId, 'presence-rejected', proof.reason);
      return;
    }
    pending.approval = {
      code: request.code,
      accountId: request.presence.accountId,
      passkeyCredentialId: binding.passkeyCredentialId,
      passkeyPublicKeyHash: proof.passkeyPublicKeyHash,
      // Attacker-chosen free text rendered in the one dialog the ACL rests on.
      label: boundedPairingLabel(request.label),
    };
    this.emit('pairing-request', { clientId: frame.clientId, label: pending.approval.label });
    // The person at the Host types what the phone displays; auto-approval types
    // it back, which is the only thing a test can do for them.
    if (this.autoApprove) this.confirmPairing(frame.clientId, request.code);
  }

  /**
   * The local confirmation — the ONLY path that writes the ACL. Exactly one
   * attempt: the secret is two digits, so a second guess would be worth 1% of
   * the space, and the compare is constant-time for the same reason.
   */
  confirmPairing(clientId, code) {
    const pending = this.clients.get(clientId)?.pairing;
    if (!pending?.approval || pending.attempted) return undefined;
    pending.attempted = true;
    if (!constantTimeEqual(utf8Encode(code), utf8Encode(pending.approval.code))) {
      this.#finishPairing(clientId, 'confirmation-mismatch');
      return undefined;
    }
    const deliveryId = randomBase64Url(DELIVERY_ID_BYTE_LENGTH);
    const record = this.acl.approve({
      accountId: pending.approval.accountId,
      passkeyCredentialId: pending.approval.passkeyCredentialId,
      passkeyPublicKeyHash: pending.approval.passkeyPublicKeyHash,
      clientStaticPublicKey: pending.clientStaticPublicKey,
      deliveryId,
      approvedBy: 'host-user',
      label: pending.approval.label,
    });
    this.emit('paired', { clientId, record });
    this.#sendControl(pending, {
      ok: true,
      hostStaticPublicKey: this.staticPublicKey,
      hostLabel: this.label,
      accountId: record.accountId,
      passkeyCredentialId: record.passkeyCredentialId,
      passkeyPublicKeyHash: record.passkeyPublicKeyHash,
      deliveryId,
    });
    this.#disposePairing(clientId);
    return record;
  }

  /** Local denial: the ACL is untouched and the invitation is spent anyway. */
  denyPairing(clientId) {
    this.#finishPairing(clientId, 'user-denied');
  }

  /** Send one denial and end the pairing; every terminal outcome runs through here. */
  #finishPairing(clientId, code, detail = null) {
    const pending = this.clients.get(clientId)?.pairing;
    if (!pending) return;
    this.emit('denied', { clientId, code, detail });
    this.#sendControl(pending, { ok: false, code });
    this.#disposePairing(clientId);
  }

  /**
   * Erase a pairing's handshake material and spend its invitation. Both,
   * always: an invitation that survived its ceremony would let a second phone
   * reserve the code the person has already answered for.
   */
  #disposePairing(clientId) {
    const state = this.clients.get(clientId);
    if (!state?.pairing) return;
    const inviteId = state.pairing.id;
    state.pairing = undefined;
    this.#retireInvitation(inviteId, 'consumed');
    this.#pruneClient(clientId);
  }

  // --- Connection -----------------------------------------------------------

  /**
   * Noise message 1 against the long-term static. Message 2's payload is the
   * fresh 32-byte challenge the presence proof must bind to, so completing the
   * handshake proves both statics and authorizes nothing.
   */
  async #onConnectionInit(frame) {
    if (!this.noiseStaticKeyPair) {
      this.emit('e2e-error', {
        clientId: frame.clientId,
        kind: 'connection',
        id: frame.id,
        error: new Error('this host has no Noise static'),
        frame,
      });
      return;
    }
    let entry;
    try {
      const handshake = await createNoiseResponder({
        prologue: e2eConnectionPrologue(this.hostId, frame.id),
        staticKeyPair: this.noiseStaticKeyPair,
      });
      const payload = await handshake.readMessage(fromBase64Url(frame.ct));
      if (payload.length !== 0) throw new Error('connection message 1 carries a payload');
      // Issued only once message 1 has decrypted, as `RemoteHost` does: nothing
      // but its own TTL reclaims a challenge.
      const { challenge, expiresAt } = this.challenges.issue();
      const message2 = await handshake.writeMessage(fromBase64Url(challenge));
      const remoteStatic = handshake.remoteStaticPublicKey;
      if (!remoteStatic) throw new Error('IK did not authenticate a Client static');
      const session = new NoiseTransportSession(handshake.session);
      entry = {
        clientId: frame.clientId,
        kind: 'connection',
        id: frame.id,
        session,
        handshakeHash: toBase64Url(session.handshakeHash),
        clientStaticPublicKey: toBase64Url(remoteStatic),
        hostChallenge: challenge,
        expiresAt,
        message2,
      };
    } catch (error) {
      // Failures before `Split` yield only a generic outer error: there is no
      // session to encrypt a denial on, so silence is the whole answer.
      this.emit('e2e-error', {
        clientId: frame.clientId,
        kind: 'connection',
        id: frame.id,
        error,
        frame,
      });
      return;
    }
    // At most one pending connection per relay client; a replacement disposes
    // its predecessor without answering it.
    this.#clientState(frame.clientId).connection = entry;
    this.#send({
      t: 'e2e',
      clientId: frame.clientId,
      kind: 'connection',
      id: frame.id,
      step: 'response',
      ct: toBase64Url(entry.message2),
    });
    this.emit('e2e-open', entry);
  }

  /**
   * Transport on a connection: the authorization control while one is pending,
   * then protocol-v1 application messages once it is established.
   */
  async #onConnectionTransport(frame) {
    const state = this.clients.get(frame.clientId);
    if (!state) return;
    if (state.established?.id === frame.id) {
      this.#onEstablishedFrame(frame.clientId, state.established, frame);
      return;
    }
    const pending = state.connection;
    if (!pending || pending.id !== frame.id) return;
    let receipt;
    try {
      receipt = pending.session.receive(fromBase64Url(frame.ct));
    } catch (error) {
      this.emit('e2e-error', {
        clientId: frame.clientId,
        kind: 'connection',
        id: frame.id,
        error,
        frame,
      });
      return;
    }
    this.emit('e2e-receive', {
      clientId: frame.clientId,
      kind: 'connection',
      id: frame.id,
      receipt,
      entry: pending,
    });
    if (receipt.kind === 'keepalive') return;
    if (receipt.kind !== 'control' || !isConnectionRequestV1(receipt.value)) {
      this.#denyConnection(frame.clientId, pending, 'protocol-rejected', 'malformed-request');
      return;
    }
    const request = receipt.value;
    // Consumed before any other work, so a challenge can never be presented
    // twice whatever the rest of this decision does.
    const challengeValid = this.challenges.consume(pending.hostChallenge);
    const binding = {
      kind: 'connection',
      hostId: this.hostId,
      connectionId: pending.id,
      hostChallenge: pending.hostChallenge,
      handshakeHash: pending.handshakeHash,
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, binding, this.policy);
    if (this.clients.get(frame.clientId)?.connection !== pending) return;
    if (!challengeValid || !proof.ok) {
      this.#denyConnection(
        frame.clientId,
        pending,
        'presence-rejected',
        challengeValid ? proof.reason : 'challenge-invalid',
      );
      return;
    }
    const authorization = this.acl.authorize({
      passkeyCredentialId: binding.passkeyCredentialId,
      clientStaticPublicKey: pending.clientStaticPublicKey,
    });
    // One record must hold all four identities. Which one failed is owner-local
    // and never returned: every miss is `pairing-required`.
    const record = authorization.record;
    const miss =
      record === null
        ? authorization.reasons.join(',')
        : record.accountId !== request.presence.accountId
          ? 'account-mismatch'
          : record.passkeyPublicKeyHash !== proof.passkeyPublicKeyHash
            ? 'passkey-key-mismatch'
            : null;
    if (miss !== null) {
      this.#denyConnection(frame.clientId, pending, 'pairing-required', miss);
      return;
    }
    this.#promoteConnection(frame.clientId, pending, record);
  }

  /** Success: answer, then hand the session's byte stream to protocol-v1. */
  #promoteConnection(clientId, pending, record) {
    const state = this.#clientState(clientId);
    state.connection = undefined;
    state.established = pending;
    this.#sendControl(pending, { ok: true, hostLabel: this.label });
    this.emit('decision', { clientId, allowed: true, record });
  }

  #denyConnection(clientId, pending, code, detail) {
    this.emit('decision', { clientId, allowed: false, code, detail });
    this.#sendControl(pending, { ok: false, code });
    const state = this.clients.get(clientId);
    if (state?.connection === pending) {
      state.connection = undefined;
      this.#pruneClient(clientId);
    }
  }

  /** One transport frame on an authorized session: protocol-v1, or a keepalive. */
  #onEstablishedFrame(clientId, established, frame) {
    let receipt;
    try {
      receipt = established.session.receive(fromBase64Url(frame.ct));
    } catch (error) {
      this.emit('e2e-error', { clientId, kind: 'connection', id: frame.id, error, frame });
      return;
    }
    this.emit('e2e-receive', { clientId, kind: 'connection', id: frame.id, receipt, entry: established });
    if (receipt.kind !== 'app') return;
    const send = (payload) => {
      for (const ciphertext of established.session.sendApp(utf8Encode(JSON.stringify(payload)))) {
        this.e2eSendCiphertext(established, ciphertext);
      }
    };
    for (const message of receipt.messages) {
      let payload;
      try {
        payload = JSON.parse(utf8Decode(message));
      } catch {
        // Authenticated, so it came from the paired Client — but a peer sending
        // non-JSON on the application stream is not one this Host can talk to.
        continue;
      }
      this.#handleRemoteApi(clientId, payload, send);
    }
  }

  // --- Remote API (protocol-v1), over whichever transport delivered it -------

  /**
   * Remote-api v1 with a synthetic directory + echo terminal. `hello` answers
   * capabilities; `directory.watch` snapshots the fake surfaces; `surface.attach`
   * streams a size banner; `terminal.write` echoes bytes back (treating `\r` as a
   * newline and re-drawing a prompt); `terminal.resize` notes the new size. Input
   * and resize only apply to the currently attached surface. Unknown methods echo
   * ok:false. `send` is how a response leaves: an encrypted application message
   * on the established e2e session.
   */
  #handleRemoteApi(clientId, data, send) {
    const request = data;
    if (!request || typeof request.requestId !== 'string' || typeof request.method !== 'string') {
      return;
    }
    const { requestId, method, params } = request;

    const respond = (response) => {
      this.emit('msg', { clientId, request, response });
      send(response);
    };
    const ok = (result = {}) => respond({ requestId, ok: true, result });
    const fail = (error) => respond({ requestId, ok: false, error });
    const event = (subId, name, eventData) => send({ subId, event: name, data: eventData });
    const emitData = (subId, text) =>
      event(subId, REMOTE_EVENTS.terminalData, { bytes: toBase64Url(utf8Encode(text)) });

    switch (method) {
      case REMOTE_METHODS.hello:
        // Mirror the shipped Host: protocol-v1 grants no layout authority.
        ok({ protocolVersion: 1, hostId: this.hostId, grants: { input: true, layout: false } });
        return;

      case REMOTE_METHODS.directoryWatch: {
        // Host convention: the subscription id is the request's own requestId.
        this.directorySubs.set(clientId, requestId);
        ok({ subId: requestId });
        event(requestId, REMOTE_EVENTS.directorySnapshot, { entries: this.#directoryEntries() });
        return;
      }

      case REMOTE_METHODS.surfaceAttach: {
        const surface = this.#surface(params?.surfaceId);
        if (!surface) return fail(`no such surface: ${params?.surfaceId ?? '(none)'}`);
        surface.cols = clampTerminalDimension(params.cols, surface.cols);
        surface.rows = clampTerminalDimension(params.rows, surface.rows);
        this.attachments.set(clientId, { surfaceId: surface.surfaceId, subId: requestId });
        ok({ cols: surface.cols, rows: surface.rows });
        emitData(
          requestId,
          `\r\n[fake-host] attached ${surface.title} (${surface.cols}x${surface.rows})\r\n$ `,
        );
        return;
      }

      case REMOTE_METHODS.terminalWrite: {
        const surface = this.#surface(params?.surfaceId);
        if (!surface) return fail(`no such surface: ${params?.surfaceId ?? '(none)'}`);
        const attachment = this.attachments.get(clientId);
        if (!attachment || attachment.surfaceId !== surface.surfaceId) {
          return fail(`surface is not attached: ${surface.surfaceId}`);
        }
        ok();
        const input = utf8Decode(fromBase64Url(params.bytes));
        const echoed = input.includes('\r') ? `${input.replace(/\r/g, '\r\n')}$ ` : input;
        emitData(attachment.subId, echoed);
        return;
      }

      case REMOTE_METHODS.terminalResize: {
        const surface = this.#surface(params?.surfaceId);
        if (!surface) return fail(`no such surface: ${params?.surfaceId ?? '(none)'}`);
        const attachment = this.attachments.get(clientId);
        if (!attachment || attachment.surfaceId !== surface.surfaceId) {
          return fail(`surface is not attached: ${surface.surfaceId}`);
        }
        surface.cols = clampTerminalDimension(params.cols, surface.cols);
        surface.rows = clampTerminalDimension(params.rows, surface.rows);
        ok({ cols: surface.cols, rows: surface.rows });
        emitData(attachment.subId, `\r\n[fake-host] resized to ${surface.cols}x${surface.rows}\r\n`);
        return;
      }

      case REMOTE_METHODS.surfaceDetach: {
        // Detach names its surface: a stale detach for a pane the client
        // already switched away from must not kill the newer attachment.
        const attachment = this.attachments.get(clientId);
        if (attachment && attachment.surfaceId === params?.surfaceId) {
          this.attachments.delete(clientId); // stops any further terminal.data
        }
        ok();
        return;
      }

      default:
        fail(`unknown method: ${method}`);
        return;
    }
  }

  /** A directory snapshot of the synthetic surfaces. */
  #directoryEntries() {
    return this.surfaces.map((surface, index) => ({
      paneRef: surface.paneRef,
      surfaceId: surface.surfaceId,
      type: 'terminal',
      title: surface.title,
      focused: index === 0,
      activity: 'prompt',
      alive: true,
      ringing: false,
      hasTODO: false,
    }));
  }

  #surface(surfaceId) {
    return this.surfaces.find((surface) => surface.surfaceId === surfaceId);
  }

  close() {
    closeSocket(this);
  }
}


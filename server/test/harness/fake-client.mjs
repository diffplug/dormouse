/**
 * A headless Client (Dormouse Pocket) speaking only the `e2e` relay envelope —
 * the initiator half of the harness in
 * `docs/specs/remote-security-model.md` -> `## Future` -> **Scope:
 * e2e-client-host**. Deliberately `PocketClient`-free: it is a bare
 * `/ws/client` socket plus the real ceremonies, so the suite tests the wire
 * rather than a production class that does not send these frames yet.
 *
 * It runs both ceremonies end to end against a live server: {@link pair} scans
 * a Host invitation, runs IK against its one-use key, obtains its presence
 * proof through the **real** `/api/reauth/begin` + `/finish` routes, and
 * decrypts the `PairingOutcomeV1`; {@link connect} does the same against the
 * pinned Host static and then speaks protocol-v1 inside the session.
 *
 * {@link open}, {@link sendCiphertext} and the `tamper` hook stay as the
 * low-level door for the transport cases in `server/test/e2e-relay.test.mjs`.
 *
 * Constructor: `{ serverUrl, sessionToken, hostId, staticKeyPair,
 * hostStaticPublicKey, origin, rpId, label }`. `serverUrl` may be
 * `http(s)://…` or `ws(s)://…`. Together with the Host's, this peer's `frames`
 * and `sent` are exactly what the relay saw, which is what the opacity
 * assertions read.
 */

import { EventEmitter } from 'node:events';

import {
  API_ROUTES,
  NoiseTransportSession,
  SELFHOST_ACCOUNT_ID,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  createNoiseInitiator,
  e2eConnectionPrologue,
  fromBase64Url,
  isConnectionOutcomeV1,
  isPairingOutcomeV1,
  pairingInvitationPrologue,
  samplePairingCode,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from 'server-lib-common';

import { e2ePrologueFor, newE2eId } from './e2e.mjs';
import {
  attachFrameSocket,
  closeSocket,
  quiet,
  receiveFrame,
  sendFrame,
  waitForFrame,
} from './frame-socket.mjs';

export class FakeClient extends EventEmitter {
  constructor({
    serverUrl,
    sessionToken,
    hostId,
    staticKeyPair,
    hostStaticPublicKey,
    origin,
    rpId,
    label = 'Fake Phone',
    socket,
  }) {
    super();
    this.hostId = hostId;
    this.sessionToken = sessionToken;
    this.staticKeyPair = staticKeyPair;
    this.hostStaticPublicKey = hostStaticPublicKey;
    this.origin = origin;
    this.rpId = rpId;
    this.label = label;
    /** The Host static this Client pinned at pairing, base64url. */
    this.pin = null;
    /** What a `KnownHostV1` keeps after a successful pairing. */
    this.knownHost = null;
    /** The live ceremony, once {@link open} / {@link pair} / {@link connect} completes. */
    this.kind = null;
    this.id = null;
    this.session = null;
    this.noise = null;
    /**
     * Transport frames already decrypted. `waitFor` matches frames that arrived
     * a tick ago, which is what a ceremony's own outcome wants — but decrypting
     * one twice advances the receive nonce past a live session.
     */
    this.consumed = new Set();
    /** Application messages that were not the response being awaited. */
    this.appMessages = [];

    this.httpUrl = serverUrl.replace(/^ws/, 'http');
    const wsBase = serverUrl.replace(/^http/, 'ws');
    const ws = attachFrameSocket(
      this,
      `${wsBase}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${encodeURIComponent(sessionToken)}`,
      socket,
    );
    ws.addEventListener('message', (ev) => receiveFrame(this, ev.data));
  }

  sendFrame(frame) {
    sendFrame(this, frame);
  }

  waitFor(predicate, timeout) {
    return waitForFrame(this, predicate, timeout);
  }

  quiet(ms) {
    return quiet(this, ms);
  }

  /** The next transport frame for a ceremony that has not been decrypted yet. */
  async nextTransport({ kind = this.kind, id = this.id, timeout } = {}) {
    const frame = await this.waitFor(
      (f) =>
        f.t === 'e2e' &&
        f.step === 'transport' &&
        f.kind === kind &&
        f.id === id &&
        !this.consumed.has(f),
      timeout,
    );
    this.consumed.add(frame);
    return frame;
  }

  /**
   * Run the IK handshake for one ceremony and promote the result into a
   * transport session. `tamper` rewrites message 1's base64url ciphertext just
   * before it goes out, which is what a hostile relay flipping a byte looks
   * like from here.
   */
  async open({
    kind = 'connection',
    id = newE2eId(),
    hostId = this.hostId,
    staticKeyPair = this.staticKeyPair,
    remoteStaticPublicKey = this.hostStaticPublicKey,
    prologue = e2ePrologueFor({ kind, hostId, id }),
    tamper,
    awaitResponse = true,
  } = {}) {
    const handshake = await createNoiseInitiator({
      prologue,
      staticKeyPair,
      remoteStaticPublicKey,
    });
    const message1 = toBase64Url(await handshake.writeMessage());
    this.kind = kind;
    this.id = id;
    this.sendFrame({
      t: 'e2e',
      hostId,
      kind,
      id,
      step: 'init',
      ct: tamper ? tamper(message1) : message1,
    });
    if (!awaitResponse) return { handshake, id, kind };

    const response = await this.waitFor(
      (f) => f.t === 'e2e' && f.kind === kind && f.id === id && f.step === 'response',
    );
    const payload = await handshake.readMessage(fromBase64Url(response.ct));
    this.noise = handshake.session;
    this.session = new NoiseTransportSession(handshake.session);
    return { handshake, id, kind, session: this.session, payload };
  }

  /** Wrap one ciphertext in a transport frame for the live ceremony. */
  sendCiphertext(ciphertext, { kind = this.kind, id = this.id } = {}) {
    this.sendFrame({
      t: 'e2e',
      hostId: this.hostId,
      kind,
      id,
      step: 'transport',
      ct: typeof ciphertext === 'string' ? ciphertext : toBase64Url(ciphertext),
    });
  }

  sendKeepalive() {
    this.sendCiphertext(this.session.sendKeepalive());
  }

  sendControl(value) {
    this.sendCiphertext(this.session.sendControl(value));
  }

  /** One application message, chunked into as many transport frames as it needs. */
  sendApp(bytes) {
    const ciphertexts = this.session.sendApp(bytes);
    for (const ciphertext of ciphertexts) this.sendCiphertext(ciphertext);
    return ciphertexts.length;
  }

  /** Decrypt one `e2e` transport frame the relay delivered. */
  receiveFrame(frame) {
    return this.session.receive(fromBase64Url(frame.ct));
  }

  // --- The presence proof ---------------------------------------------------

  /**
   * The proof both ceremonies carry, through the real routes: `begin` mints the
   * nonce and derives the challenge from the binding, the authenticator signs
   * it, and `finish` verifies. The Server's success authorizes nothing — the
   * Host recomputes the same challenge and verifies the same assertion — so the
   * `finish` call is here because a Client makes it, not because it proves
   * anything to the Host.
   */
  async presenceProof({ binding, accountId = SELFHOST_ACCOUNT_ID, authenticator }) {
    const begin = await this.#post(API_ROUTES.reauthBegin, { binding });
    if (!begin.ok) throw new Error(`reauth/begin answered ${begin.status}`);
    const { challenge, serverNonce, rpId } = await begin.json();
    const assertion = await authenticator.assert({
      challenge,
      origin: this.origin,
      rpId: this.rpId ?? rpId,
    });
    const finish = await this.#post(API_ROUTES.reauthFinish, { serverNonce, assertion });
    if (!finish.ok) throw new Error(`reauth/finish answered ${finish.status}`);
    return {
      binding,
      serverNonce,
      accountId,
      passkeyCredentialId: authenticator.credentialId,
      passkeyPublicKey: authenticator.publicKey,
      assertion,
    };
  }

  #post(path, body) {
    return fetch(`${this.httpUrl}${path}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.sessionToken}`,
      },
      body: JSON.stringify(body),
    });
  }

  // --- Pairing --------------------------------------------------------------

  /** IK against the scanned invitation's one-use key; no ACL exists yet. */
  async openPairing(invitation, { staticKeyPair = this.staticKeyPair } = {}) {
    const initiator = await createNoiseInitiator({
      prologue: pairingInvitationPrologue(invitation),
      staticKeyPair,
      remoteStaticPublicKey: invitation.ephPub,
    });
    const message1 = await initiator.writeMessage();
    this.kind = 'pairing';
    this.id = invitation.inviteId;
    this.sendFrame({
      t: 'e2e',
      hostId: invitation.hostId,
      kind: 'pairing',
      id: invitation.inviteId,
      step: 'init',
      ct: toBase64Url(message1),
    });
    const response = await this.waitFor(
      (f) =>
        f.t === 'e2e' && f.kind === 'pairing' && f.id === invitation.inviteId && f.step === 'response',
    );
    await initiator.readMessage(fromBase64Url(response.ct));
    this.noise = initiator.session;
    this.session = new NoiseTransportSession(initiator.session);
    return { session: this.session, handshakeHash: toBase64Url(this.session.handshakeHash) };
  }

  /**
   * The whole pairing ceremony: scan, IK, one control message carrying the
   * displayed code and the presence proof, and the single outcome — which is
   * believed only after it decrypts on this Client's own session.
   *
   * `binding` overrides what the proof is bound to, so a test can present a
   * proof for the wrong ceremony without touching anything else.
   */
  async pair({
    invitation,
    authenticator,
    accountId = SELFHOST_ACCOUNT_ID,
    staticKeyPair,
    label = this.label,
    code,
    binding,
  }) {
    const { session, handshakeHash } = await this.openPairing(invitation, { staticKeyPair });
    const bound = binding ?? {
      kind: 'pairing',
      hostId: invitation.hostId,
      handshakeHash,
      passkeyCredentialId: authenticator.credentialId,
    };
    const presence = await this.presenceProof({ binding: bound, accountId, authenticator });
    const displayed = code ?? samplePairingCode();
    this.sendControl({ code: displayed, label, presence });
    const frame = await this.nextTransport({ kind: 'pairing', id: invitation.inviteId });
    const receipt = session.receive(fromBase64Url(frame.ct));
    const outcome =
      receipt.kind === 'control' && isPairingOutcomeV1(receipt.value) ? receipt.value : null;
    if (outcome?.ok === true) {
      // A changed static under an existing pin is a terminal security error on
      // the real Client; here it is simply the pin this Client now holds.
      this.pin = outcome.hostStaticPublicKey;
      this.knownHost = {
        hostId: invitation.hostId,
        deliveryId: outcome.deliveryId,
        accountId: outcome.accountId,
        passkeyCredentialId: outcome.passkeyCredentialId,
        passkeyPublicKeyHash: outcome.passkeyPublicKeyHash,
      };
    }
    return { ok: outcome?.ok === true, outcome, code: displayed, ct: frame.ct, session };
  }

  // --- Connection -----------------------------------------------------------

  /** IK against the pinned Host static; message 2 carries the Host challenge. */
  async openConnection({
    connectionId = newE2eId(),
    hostStaticPublicKey = this.pin ?? this.hostStaticPublicKey,
    staticKeyPair = this.staticKeyPair,
  } = {}) {
    const remoteStaticPublicKey =
      typeof hostStaticPublicKey === 'string'
        ? fromBase64Url(hostStaticPublicKey)
        : hostStaticPublicKey;
    const initiator = await createNoiseInitiator({
      prologue: e2eConnectionPrologue(this.hostId, connectionId),
      staticKeyPair,
      remoteStaticPublicKey,
    });
    const message1 = await initiator.writeMessage();
    this.kind = 'connection';
    this.id = connectionId;
    this.sendFrame({
      t: 'e2e',
      hostId: this.hostId,
      kind: 'connection',
      id: connectionId,
      step: 'init',
      ct: toBase64Url(message1),
    });
    const response = await this.waitFor(
      (f) =>
        f.t === 'e2e' && f.kind === 'connection' && f.id === connectionId && f.step === 'response',
    );
    const hostChallenge = await initiator.readMessage(fromBase64Url(response.ct));
    this.noise = initiator.session;
    this.session = new NoiseTransportSession(initiator.session);
    return {
      session: this.session,
      connectionId,
      hostChallenge: toBase64Url(hostChallenge),
      handshakeHash: toBase64Url(this.session.handshakeHash),
    };
  }

  /**
   * The whole connection ceremony. `record` is this Client's own `KnownHostV1`
   * (what {@link pair} returned), used only for its `accountId`; the Host
   * static comes from the pin unless one is supplied.
   */
  async connect({
    record = this.knownHost,
    authenticator,
    accountId = record?.accountId ?? SELFHOST_ACCOUNT_ID,
    hostStaticPublicKey,
    staticKeyPair,
    connectionId,
    binding,
  } = {}) {
    const opened = await this.openConnection({ connectionId, hostStaticPublicKey, staticKeyPair });
    const bound = binding ?? {
      kind: 'connection',
      hostId: this.hostId,
      connectionId: opened.connectionId,
      hostChallenge: opened.hostChallenge,
      handshakeHash: opened.handshakeHash,
      passkeyCredentialId: authenticator.credentialId,
    };
    const presence = await this.presenceProof({ binding: bound, accountId, authenticator });
    this.sendControl({ presence });
    const frame = await this.nextTransport({ kind: 'connection', id: opened.connectionId });
    const receipt = opened.session.receive(fromBase64Url(frame.ct));
    const outcome =
      receipt.kind === 'control' && isConnectionOutcomeV1(receipt.value) ? receipt.value : null;
    return { ok: outcome?.ok === true, outcome, ct: frame.ct, ...opened };
  }

  /**
   * One protocol-v1 request/response inside the established session. Anything
   * that is not the awaited response — an event the Host pushed first — is kept
   * on {@link appMessages} rather than dropped.
   */
  async remoteRequest(request) {
    this.sendApp(utf8Encode(JSON.stringify(request)));
    for (;;) {
      const frame = await this.nextTransport();
      const receipt = this.session.receive(fromBase64Url(frame.ct));
      if (receipt.kind !== 'app') continue;
      for (const message of receipt.messages) {
        const payload = JSON.parse(utf8Decode(message));
        if (payload.requestId === request.requestId) return payload;
        this.appMessages.push(payload);
      }
    }
  }

  close() {
    closeSocket(this);
  }
}

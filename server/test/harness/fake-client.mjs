/**
 * A headless Client (Dormouse Pocket) that speaks only the `e2e` relay envelope
 * — the initiator half of the harness in
 * `docs/specs/remote-security-model.md` -> `## Future` -> **Scope:
 * e2e-client-host**. Deliberately `PocketClient`-free: it is a bare `/ws/client`
 * socket plus one Noise IK initiator, so the suite tests the wire rather than a
 * production class that does not send these frames yet.
 *
 * Both statics are injected: the test mints both halves and hands the Client
 * the Host's public key as the pinned `rs`.
 *
 * Constructor: `{ serverUrl, sessionToken, hostId, staticKeyPair,
 * hostStaticPublicKey }`. `serverUrl` may be `http(s)://…` or `ws(s)://…`.
 * Together with the Host's, this peer's `frames` and `sent` are exactly what
 * the relay saw, which is what the opacity assertions read.
 */

import { EventEmitter } from 'node:events';

import {
  NoiseTransportSession,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  createNoiseInitiator,
  fromBase64Url,
  toBase64Url,
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
  constructor({ serverUrl, sessionToken, hostId, staticKeyPair, hostStaticPublicKey }) {
    super();
    this.hostId = hostId;
    this.staticKeyPair = staticKeyPair;
    this.hostStaticPublicKey = hostStaticPublicKey;
    /** The live ceremony, once {@link open} completes. */
    this.kind = null;
    this.id = null;
    this.session = null;
    this.noise = null;

    const wsBase = serverUrl.replace(/^http/, 'ws');
    const ws = attachFrameSocket(
      this,
      `${wsBase}${WS_ROUTES.client}?${WS_TOKEN_PARAM}=${encodeURIComponent(sessionToken)}`,
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
    await handshake.readMessage(fromBase64Url(response.ct));
    this.noise = handshake.session;
    this.session = new NoiseTransportSession(handshake.session);
    return { handshake, id, kind, session: this.session };
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

  close() {
    closeSocket(this);
  }
}

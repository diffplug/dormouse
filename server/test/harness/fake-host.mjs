/**
 * A headless Node Host (Dormouse Terminal) for exercising the relay end to end.
 *
 * It speaks the Host side of the wire contract (server-lib-common `wire.ts`)
 * over a real `/ws/host` socket, wiring the exact security primitives the real
 * standalone Host uses — `HostAcl`, `HostChallengeIssuer`,
 * `PairingCeremony`, and `authorizeConnection`. Everything is in memory, so a
 * fresh instance (reconnecting with the same token) models a Host restart: its
 * ACL starts empty again.
 *
 * Constructor: `{ serverUrl, hostToken, hostId, origin, rpId, autoApprove,
 * noiseStaticKeyPair }`. `serverUrl` may be `http(s)://…` or `ws(s)://…`. When
 * `autoApprove` is true a `pair` is approved the moment it arrives; otherwise
 * call `approve(clientId)` / `deny(clientId)` from the pairing-approval hook.
 * Subscribe to events for logs and assertions: `open`, `close`, `pair`,
 * `pair-status`, `paired`, `denied`, `connect`, `decision`, `msg`,
 * `client-gone`, `setup-token-redeemed`, `e2e-open`, `e2e-receive`,
 * `e2e-error`.
 *
 * `noiseStaticKeyPair` turns on the `e2e` half: the Host answers `init` as the
 * IK responder and everything after it as a `NoiseTransportSession`. Both
 * statics are injected (server.md -> Relay).
 *
 * The handshake smoke test and the manual `scripts/fake-host.mjs` dev
 * stand-in both reuse this class.
 */

import { EventEmitter } from 'node:events';

import {
  HostAcl,
  HostChallengeIssuer,
  NoiseTransportSession,
  PairingCeremony,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  authorizeConnection,
  clampTerminalDimension,
  createNoiseResponder,
  isE2eServerToHostFrame,
  isPairStatusQuery,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from 'server-lib-common';

import { e2ePrologueFor } from './e2e.mjs';
import { attachFrameSocket, closeSocket, receiveFrame, sendFrame } from './frame-socket.mjs';

export class FakeHost extends EventEmitter {
  constructor({
    serverUrl,
    hostToken,
    hostId,
    origin,
    rpId,
    autoApprove = true,
    noiseStaticKeyPair,
  }) {
    super();
    this.hostId = hostId;
    this.autoApprove = autoApprove;
    this.noiseStaticKeyPair = noiseStaticKeyPair;
    /** `${clientId}|${kind}|${id}` → the live (or poisoned) e2e ceremony. */
    this.e2e = new Map();
    this.policy = { rpId, origin };
    this.acl = new HostAcl(hostId);
    this.challenges = new HostChallengeIssuer();
    this.ceremony = new PairingCeremony(this.acl);
    /** clientIds whose connection the Host allowed — the `msg` gate on this side. */
    this.established = new Set();
    /** clientId → pairingId awaiting a manual approve/deny (autoApprove off). */
    this.pending = new Map();
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

    const wsBase = serverUrl.replace(/^http/, 'ws');
    const ws = attachFrameSocket(this, `${wsBase}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${hostToken}`);
    ws.addEventListener('message', (ev) => {
      void this.#onFrame(ev.data);
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
    if (frame.t === 'setup-token-redeemed') {
      // The one server→host frame addressing no Client, so it is handled before
      // the clientId guard. It names the mint, never the token — the real Host
      // routes it to whichever panel displayed that code (remote-host.ts).
      this.emit('setup-token-redeemed', { mintId: frame.mintId });
      return;
    }
    if (typeof frame.clientId !== 'string') return;
    const { clientId } = frame;
    switch (frame.t) {
      case 'pair': {
        this.emit('pair', { clientId, request: frame.request });
        const ticket = this.ceremony.begin(frame.request);
        this.pending.set(clientId, ticket.pairingId);
        if (this.autoApprove) this.approve(clientId);
        return;
      }
      case 'pair-status': {
        // Advisory display truth, answered straight from the ACL: no ticket, no
        // challenge, and nothing here may influence the `connect2` decision.
        // Mirrors the real Host exactly (remote-host.ts #onPairStatus),
        // validation included, so tests cannot pass against behavior it lacks.
        const paired =
          isPairStatusQuery(frame.query) && this.acl.findActive(frame.query) !== undefined;
        this.emit('pair-status', { clientId, query: frame.query, paired });
        this.#send({ t: 'pair-status-result', clientId, paired });
        return;
      }
      case 'connect': {
        const { challenge, expiresAt } = this.challenges.issue();
        this.emit('connect', { clientId, challenge });
        this.#send({ t: 'challenge', clientId, challenge, expiresAt });
        return;
      }
      case 'connect2': {
        const decision = await authorizeConnection(
          { hostId: this.hostId, acl: this.acl, challenges: this.challenges, policy: this.policy },
          frame.request,
        );
        if (decision.allowed) this.established.add(clientId);
        this.emit('decision', { clientId, allowed: decision.allowed, failures: decision.failures });
        // `failures` is optional on the wire; omit it on an allowed decision.
        this.#send({
          t: 'decision',
          clientId,
          allowed: decision.allowed,
          ...(decision.allowed ? {} : { failures: decision.failures }),
        });
        return;
      }
      case 'msg': {
        if (!this.established.has(clientId)) return; // gate: never before an allowed decision
        this.#handleRemoteApi(clientId, frame.data);
        return;
      }
      case 'client-gone': {
        this.established.delete(clientId);
        this.pending.delete(clientId);
        this.directorySubs.delete(clientId);
        this.attachments.delete(clientId);
        for (const [key, entry] of this.e2e) {
          if (entry.clientId === clientId) this.e2e.delete(key);
        }
        this.emit('client-gone', { clientId });
        return;
      }
      default:
        return;
    }
  }

  // --- The `e2e` envelope ---------------------------------------------------

  /**
   * One `e2e` frame: `init` is the IK responder's message 1 read plus message 2
   * write, everything after it is transport on the resulting session.
   *
   * A failure keeps the poisoned session rather than erasing it, so a test can
   * see that the session — not just this frame — is dead. The real Host erases
   * the entry (`docs/specs/remote-security-model.md` -> Host bounds); the
   * observable rule, that nothing later decrypts, is the same either way.
   */
  async #onE2e(frame) {
    if (!isE2eServerToHostFrame(frame)) {
      this.emit('e2e-error', { error: new Error('malformed e2e frame'), frame });
      return;
    }
    const { clientId, kind, id } = frame;
    const key = `${clientId}|${kind}|${id}`;
    try {
      if (frame.step === 'init') {
        if (!this.noiseStaticKeyPair) throw new Error('this host has no Noise static');
        const handshake = await createNoiseResponder({
          prologue: e2ePrologueFor({ kind, hostId: this.hostId, id }),
          staticKeyPair: this.noiseStaticKeyPair,
        });
        await handshake.readMessage(fromBase64Url(frame.ct));
        const message2 = await handshake.writeMessage();
        const entry = {
          clientId,
          kind,
          id,
          session: new NoiseTransportSession(handshake.session),
          // IK authenticates the initiator's static: this is the key the ACL
          // conjunction is checked against once the ceremony lands (stage 4).
          clientStaticPublicKey: handshake.remoteStaticPublicKey,
        };
        this.e2e.set(key, entry);
        this.#send({ t: 'e2e', clientId, kind, id, step: 'response', ct: toBase64Url(message2) });
        this.emit('e2e-open', entry);
        return;
      }
      const entry = this.e2e.get(key);
      if (!entry) throw new Error('no e2e session for this client, kind, and id');
      const receipt = entry.session.receive(fromBase64Url(frame.ct));
      this.emit('e2e-receive', { clientId, kind, id, receipt, entry });
    } catch (error) {
      this.emit('e2e-error', { clientId, kind, id, error, frame });
    }
  }

  /** The most recent ceremony for a client; `#onE2e` does the keyed lookup. */
  e2eEntry(clientId) {
    let found;
    for (const entry of this.e2e.values()) if (entry.clientId === clientId) found = entry;
    return found;
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
   * Remote-api v1 with a synthetic directory + echo terminal. `hello` answers
   * capabilities; `directory.watch` snapshots the fake surfaces; `surface.attach`
   * streams a size banner; `terminal.write` echoes bytes back (treating `\r` as a
   * newline and re-drawing a prompt); `terminal.resize` notes the new size. Input
   * and resize only apply to the currently attached surface. Unknown methods echo
   * ok:false.
   */
  #handleRemoteApi(clientId, data) {
    const request = data;
    if (!request || typeof request.requestId !== 'string' || typeof request.method !== 'string') {
      return;
    }
    const { requestId, method, params } = request;

    const respond = (response) => {
      this.emit('msg', { clientId, request, response });
      this.#send({ t: 'msg', clientId, data: response });
    };
    const ok = (result = {}) => respond({ requestId, ok: true, result });
    const fail = (error) => respond({ requestId, ok: false, error });

    switch (method) {
      case REMOTE_METHODS.hello:
        // Mirror the shipped Host: protocol-v1 grants no layout authority.
        ok({ protocolVersion: 1, hostId: this.hostId, grants: { input: true, layout: false } });
        return;

      case REMOTE_METHODS.directoryWatch: {
        // Host convention: the subscription id is the request's own requestId.
        this.directorySubs.set(clientId, requestId);
        ok({ subId: requestId });
        this.#event(clientId, requestId, REMOTE_EVENTS.directorySnapshot, {
          entries: this.#directoryEntries(),
        });
        return;
      }

      case REMOTE_METHODS.surfaceAttach: {
        const surface = this.#surface(params?.surfaceId);
        if (!surface) return fail(`no such surface: ${params?.surfaceId ?? '(none)'}`);
        surface.cols = clampTerminalDimension(params.cols, surface.cols);
        surface.rows = clampTerminalDimension(params.rows, surface.rows);
        this.attachments.set(clientId, { surfaceId: surface.surfaceId, subId: requestId });
        ok({ cols: surface.cols, rows: surface.rows });
        this.#emitData(
          clientId,
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
        this.#emitData(clientId, attachment.subId, echoed);
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
        this.#emitData(
          clientId,
          attachment.subId,
          `\r\n[fake-host] resized to ${surface.cols}x${surface.rows}\r\n`,
        );
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

  /** Send a remote-api event to a client, wrapped in a `msg` relay frame. */
  #event(clientId, subId, event, eventData) {
    this.#send({ t: 'msg', clientId, data: { subId, event, data: eventData } });
  }

  /** Emit a `terminal.data` event with `text` as base64url utf8 PTY bytes. */
  #emitData(clientId, subId, text) {
    this.#event(clientId, subId, REMOTE_EVENTS.terminalData, {
      bytes: toBase64Url(utf8Encode(text)),
    });
  }

  /** Local approval on the Host: the only path that writes to the ACL. */
  approve(clientId, { approvedBy = 'host-user', label } = {}) {
    const pairingId = this.pending.get(clientId);
    if (!pairingId) return undefined;
    this.pending.delete(clientId);
    const record = this.ceremony.approve(pairingId, { approvedBy, label });
    this.emit('paired', { clientId, record });
    this.#send({ t: 'pair-result', clientId, approved: true, record });
    return record;
  }

  /** Local denial on the Host: the ACL is untouched. */
  deny(clientId, { error = 'pairing denied by host' } = {}) {
    const pairingId = this.pending.get(clientId);
    if (!pairingId) return;
    this.pending.delete(clientId);
    this.ceremony.deny(pairingId);
    this.emit('denied', { clientId });
    this.#send({ t: 'pair-result', clientId, approved: false, error });
  }

  close() {
    closeSocket(this);
  }
}

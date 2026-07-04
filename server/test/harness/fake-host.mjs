/**
 * A headless Node Host (Dormouse Terminal) for exercising the relay end to end.
 *
 * It speaks the Host side of the wire contract (server-lib-common `wire.ts`)
 * over a real `/ws/host` socket, wiring the exact security primitives the real
 * standalone Host will use in slice 4 — `HostAcl`, `HostChallengeIssuer`,
 * `PairingCeremony`, and `authorizeConnection`. Everything is in memory, so a
 * fresh instance (reconnecting with the same token) models a Host restart: its
 * ACL starts empty again.
 *
 * Constructor: `{ serverUrl, hostToken, hostId, origin, rpId, autoApprove }`.
 * `serverUrl` may be `http(s)://…` or `ws(s)://…`. When `autoApprove` is true a
 * `pair` is approved the moment it arrives; otherwise call `approve(clientId)` /
 * `deny(clientId)` from the pairing-approval hook. Subscribe to events for logs
 * and assertions: `open`, `close`, `pair`, `paired`, `denied`, `connect`,
 * `decision`, `msg`, `client-gone`.
 *
 * Slice 5's smoke test and manual `scripts/fake-host.mjs` reuse this class.
 */

import { EventEmitter } from 'node:events';

import {
  HostAcl,
  HostChallengeIssuer,
  PairingCeremony,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  WS_ROUTES,
  WS_TOKEN_PARAM,
  authorizeConnection,
  clampTerminalDimension,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
} from 'server-lib-common';

export class FakeHost extends EventEmitter {
  constructor({ serverUrl, hostToken, hostId, origin, rpId, autoApprove = true }) {
    super();
    this.hostId = hostId;
    this.autoApprove = autoApprove;
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
    this.ws = new WebSocket(`${wsBase}${WS_ROUTES.host}?${WS_TOKEN_PARAM}=${hostToken}`);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => {
        this.emit('open');
        resolve();
      });
      this.ws.addEventListener('error', (ev) => reject(ev.error ?? new Error('host ws error')));
      this.ws.addEventListener('close', (ev) => reject(new Error(`closed before open (${ev.code})`)));
    });
    this.closed = new Promise((resolve) => this.ws.addEventListener('close', (ev) => resolve(ev)));
    this.ws.addEventListener('close', (ev) => this.emit('close', ev));
    this.ws.addEventListener('message', (ev) => {
      void this.#onFrame(ev.data);
    });
  }

  #send(frame) {
    try {
      this.ws.send(JSON.stringify(frame));
    } catch {
      /* socket mid-close */
    }
  }

  async #onFrame(raw) {
    let frame;
    try {
      frame = JSON.parse(typeof raw === 'string' ? raw : '');
    } catch {
      return;
    }
    if (!frame || typeof frame.t !== 'string' || typeof frame.clientId !== 'string') return;
    const { clientId } = frame;
    switch (frame.t) {
      case 'pair': {
        this.emit('pair', { clientId, request: frame.request });
        const ticket = this.ceremony.begin(frame.request);
        this.pending.set(clientId, ticket.pairingId);
        if (this.autoApprove) this.approve(clientId);
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
        this.emit('client-gone', { clientId });
        return;
      }
      default:
        return;
    }
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
        ok({ protocolVersion: 1, hostId: this.hostId, grants: { input: true, layout: true } });
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
    try {
      this.ws.close();
    } catch {
      /* already closing */
    }
  }
}

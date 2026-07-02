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
  WS_ROUTES,
  WS_TOKEN_PARAM,
  authorizeConnection,
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
        this.emit('client-gone', { clientId });
        return;
      }
      default:
        return;
    }
  }

  /** Minimal remote-api v1: answer `hello`, refuse everything else with ok:false. */
  #handleRemoteApi(clientId, data) {
    const request = data;
    if (!request || typeof request.requestId !== 'string' || typeof request.method !== 'string') {
      return;
    }
    let response;
    if (request.method === 'hello') {
      response = {
        requestId: request.requestId,
        ok: true,
        result: { protocolVersion: 1, hostId: this.hostId, grants: { input: true, layout: true } },
      };
    } else {
      response = {
        requestId: request.requestId,
        ok: false,
        error: `unknown method: ${request.method}`,
      };
    }
    this.emit('msg', { clientId, request, response });
    this.#send({ t: 'msg', clientId, data: response });
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

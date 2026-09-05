/**
 * A relay that is trying, in every way a relay can, to learn or change what the
 * two endpoints say to each other.
 *
 * It sits where `relay/src/relay.ts` sits — the real {@link RelayHub}, wrapped
 * rather than reimplemented, so what it *routes* is the shipped behavior — and
 * adds the four things a hostile operator has: it records every frame, and it
 * may drop, reorder, duplicate, modify, or invent one on either egress leg.
 *
 * `guards: false` removes the relay's own `ct` / `id` / shape checks, which are
 * defense in depth and nothing more: a Burrow runs the same guard on arrival, so
 * a guard-less relay must weaken no Burrow bound
 * (`docs/specs/remote-security-model.md` -> Burrow bounds).
 *
 * Hand `clientSocket` to a `FakeClient` and `burrowSocket` to a `FakeBurrow`; both
 * accept an injected socket for exactly this.
 */

import { randomBytes } from 'node:crypto';

import { toBase64Url } from 'remote-lib-common';

import { RelayHub } from '../../dist/relay.js';
import { memorySocketPair } from './memory-socket.mjs';

export function createMaliciousRelay({ burrowId, guards = true }) {
  const [clientSocket, relayClientEnd] = memorySocketPair();
  const [burrowSocket, relayBurrowEnd] = memorySocketPair();

  /** Every frame this relay handled, in order: `{ from, to, frame }`. */
  const seen = [];
  const relay = {
    clientSocket,
    burrowSocket,
    seen,
    /**
     * What actually leaves the relay: `(frame, to) => frame[]`. Return `[]` to
     * drop, two entries to duplicate, a rewritten one to tamper, or extras to
     * inject. Null forwards untouched.
     */
    tamper: null,
    /** Everything both peers put on the wire, as JSON — the opacity oracle. */
    view() {
      return JSON.stringify(seen.map((entry) => entry.frame));
    },
    /** Originate a frame the relay made up, addressed to one peer. */
    injectTo(to, frame) {
      deliver(to, frame);
    },
    close() {
      relayClientEnd.close();
      relayBurrowEnd.close();
    },
  };

  /** Put one frame on a peer's socket, after the tamper hook has had it. */
  function deliver(to, frame) {
    const end = to === 'client' ? relayClientEnd : relayBurrowEnd;
    const outgoing = relay.tamper ? relay.tamper(frame, to) : [frame];
    for (const one of outgoing) {
      seen.push({ from: 'relay', to, frame: one });
      try {
        end.send(JSON.stringify(one));
      } catch {
        // The peer closed between our decision and this send.
      }
    }
  }

  const toClient = { send: (data) => deliver('client', JSON.parse(data)), close: () => {} };
  const toBurrow = { send: (data) => deliver('burrow', JSON.parse(data)), close: () => {} };

  if (guards) {
    const hub = new RelayHub();
    const burrow = hub.registerBurrow(burrowId, toBurrow);
    const client = hub.registerClient(toClient, { expiresAt: Number.POSITIVE_INFINITY });
    relayClientEnd.addEventListener('message', (ev) => {
      seen.push({ from: 'client', to: 'relay', frame: JSON.parse(ev.data) });
      hub.onClientFrame(client, ev.data);
    });
    relayBurrowEnd.addEventListener('message', (ev) => {
      seen.push({ from: 'burrow', to: 'relay', frame: JSON.parse(ev.data) });
      hub.onBurrowFrame(burrow, ev.data);
    });
    relay.clientId = client.clientId;
    return relay;
  }

  // The guard-less variant: the same binding and stamping, with every shape,
  // length, and encoding check deleted. Nothing here validates `ct` or `id`.
  const clientId = toBase64Url(randomBytes(16));
  relay.clientId = clientId;
  let bound = null;
  relayClientEnd.addEventListener('message', (ev) => {
    const frame = safeParse(ev.data);
    if (!frame) return;
    seen.push({ from: 'client', to: 'relay', frame });
    if (frame.t !== 'e2e') return;
    if (frame.step === 'init') bound = frame.burrowId;
    else if (bound !== frame.burrowId) return;
    deliver('burrow', { ...frame, clientId });
  });
  relayBurrowEnd.addEventListener('message', (ev) => {
    const frame = safeParse(ev.data);
    if (!frame) return;
    seen.push({ from: 'burrow', to: 'relay', frame });
    if (frame.t !== 'e2e' || frame.clientId !== clientId) return;
    const { clientId: _stripped, ...rest } = frame;
    deliver('client', { ...rest, burrowId });
  });
  return relay;
}

function safeParse(raw) {
  try {
    const parsed = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null ? parsed : null;
  } catch {
    return null;
  }
}

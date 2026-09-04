/**
 * The relay, in memory: two {@link FakeSocket}s bridged by the routing rules of
 * `docs/specs/server.md` → Relay.
 *
 * Test-only, and shared for the reason `test-fake-socket.ts` and
 * `test-e2e-client.ts` are: the Pocket client and the Host both have to be
 * driven against *the same* idea of what the relay does, and two private copies
 * would be two opinions about which frames reach whom. It stamps `clientId` on
 * the way to the Host and `hostId` on the way back, binds each Client socket on
 * its own `init`, forwards `transport` only inside that binding, and decodes no
 * ciphertext. `server/src/relay.ts` is the original of those rules and
 * `server/test/e2e-relay.test.mjs` is what pins them there; nothing mechanically
 * ties this copy to it, so an edit to either belongs in both.
 *
 * Everything it deliberately does *not* do is the point of the harness: it
 * keeps no Noise state, learns no outcome, and has no notion of an authorized
 * session, so a pairing or connection that succeeds here succeeded end to end.
 */

import { isE2eClientFrame, isE2eHostFrame, type E2eKind } from 'remote-lib-common';
import { FakeSocket } from './test-fake-socket';
import { testRoutingId } from './test-e2e-client';

export interface TestRelay {
  /** The `hostId` this relay routes to; a frame naming another gets an `error`. */
  readonly hostId: string;
  /** The secret the relay assigns the Client socket, and stamps Host-bound. */
  readonly clientId: string;
  /** The Host's socket — hand this to `RemoteHost`'s `createWebSocket`. */
  readonly hostSocket: FakeSocket;
  /**
   * The Client's socket, opened on a microtask so `PocketClient.openSocket`
   * — which registers its `open` listener synchronously — always sees it.
   */
  openClientSocket(): FakeSocket;
  /** The Host went away: what a client bound to it is told. */
  hostGone(): void;
  /** An `error` frame, as the relay answers a client it cannot route for. */
  errorClient(message: string): void;
  /** Corrupt the `ct` of the next Host→Client frame, as a hostile relay would. */
  tamperNextHostFrame(): void;
  /** Stop routing, without closing either socket. */
  stop(): void;
}

export function createTestRelay(options: {
  hostId: string;
  hostSocket: FakeSocket;
  clientId?: string;
}): TestRelay {
  const { hostId, hostSocket } = options;
  const clientId = options.clientId ?? testRoutingId();
  /**
   * The live Client socket and the one Host it is bound to. Per socket, not per
   * relay: `registerClient` starts every registration unbound, so a reconnect
   * must send its own `init` before anything is forwarded for it.
   */
  let client: { socket: FakeSocket; bound: string | null } | null = null;
  let live = true;
  let tamper = false;

  hostSocket.onSend = (frame) => {
    if (!live || !client) return;
    // A malformed Host frame is dropped, where a malformed Client frame earns
    // an `error` — the asymmetry is the relay's.
    if (frame.t !== 'e2e' || !isE2eHostFrame(frame)) return;
    if (frame.clientId !== clientId) return;
    // Late replies from a Host this client has left are not routed, and cannot
    // re-establish anything.
    if (client.bound !== hostId) return;
    const ct = tamper ? flipLastCharacter(frame.ct) : frame.ct;
    tamper = false;
    client.socket.receive({
      t: 'e2e',
      hostId,
      kind: frame.kind as E2eKind,
      id: frame.id,
      step: frame.step,
      ct,
    });
  };

  return {
    hostId,
    clientId,
    hostSocket,
    openClientSocket() {
      const socket = new FakeSocket();
      // A replaced registration is a client gone, as `unregisterClient` reports.
      if (client) hostSocket.receive({ t: 'client-gone', clientId });
      const registration: { socket: FakeSocket; bound: string | null } = { socket, bound: null };
      client = registration;
      socket.onSend = (frame) => {
        if (!live) return;
        if (frame.t !== 'e2e') {
          socket.receive({ t: 'error', error: 'unknown frame type' });
          return;
        }
        if (!isE2eClientFrame(frame)) {
          socket.receive({ t: 'error', error: 'malformed e2e frame' });
          return;
        }
        if (frame.hostId !== hostId) {
          socket.receive({ t: 'error', error: 'host is not connected' });
          return;
        }
        if (frame.step === 'init') registration.bound = frame.hostId;
        else if (registration.bound !== frame.hostId) return;
        // Stamped, exactly as `registerClient`'s secret is: the Client never
        // sees or sends its own id.
        hostSocket.receive({ ...frame, clientId });
      };
      // After the caller's `open` listener is registered, never before.
      queueMicrotask(() => socket.open());
      return socket;
    },
    hostGone() {
      if (!client) return;
      client.bound = null;
      client.socket.receive({ t: 'host-gone' });
    },
    errorClient(message) {
      client?.socket.receive({ t: 'error', error: message });
    },
    tamperNextHostFrame() {
      tamper = true;
    },
    stop() {
      live = false;
    },
  };
}

/** One base64url character changed: authenticated ciphertext, no longer valid. */
function flipLastCharacter(ct: string): string {
  const last = ct.slice(-1);
  return `${ct.slice(0, -1)}${last === 'A' ? 'B' : 'A'}`;
}

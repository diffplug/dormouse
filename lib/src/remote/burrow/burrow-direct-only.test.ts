/**
 * A paired phone's session under a held path policy — Local networks
 * (`docs/specs/remote-network.md` -> "Local networks"): the outcome says it is
 * direct-only, an application message off the relay ends it unread, and so do
 * a given-up attempt and the direct deadline, each with the goodbye. Without a
 * path policy the relay carries protocol-v1 as ever. And every `stop()` tells
 * its sessions so.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PAIRING_TTL_MS,
  DIRECT_ONLY_DEADLINE_MS,
  SESSION_END_V1,
  mintNoiseStaticKeyPair,
  toBase64Url,
  utf8Encode,
  type BurrowAclRecord,
  type NoiseKeyPair,
  type NoiseTransportSession,
  type PresenceBinding,
} from 'remote-lib-common';
import { BurrowRuntime } from './burrow-runtime';
import type { RemoteApiSessionLike } from './established-session';
import type { BurrowEnrollment } from './enrollment';
import type { PendingPairing } from './pairing-approval';
import { FakeSocket } from '../test-fake-socket';
import { createTestClock } from '../test-timers';
import { FakeDirectNetwork, OFF_LAN_PAIR, lanOnlyPolicy } from '../direct/test-fake-peer';
import type { DirectPeering } from '../direct/direct-peer';
import {
  createTestAuthenticator,
  e2eFramesFor,
  openConnectionSession,
  openDirectPath,
  pairThroughSocket,
  presenceProofFor,
  randomBase64Url,
  readOutcome,
  sendE2eFrame,
  settle,
  testRoutingId,
  type TestAuthenticator,
} from '../test-e2e-client';

const ORIGIN = 'https://relay.dormouse.sh';
const RP_ID = 'relay.dormouse.sh';
const LABEL = 'Ned’s laptop';

describe('BurrowRuntime direct-only sessions', () => {
  let enrollment: BurrowEnrollment;
  let authenticator: TestAuthenticator;
  let socket: FakeSocket;
  let burrow: BurrowRuntime;
  let clock: ReturnType<typeof createTestClock>;
  let approvals: PendingPairing[];
  let sessions: Array<{ handled: unknown[]; disposed: boolean; send: (payload: unknown) => void }>;
  let warn: ReturnType<typeof vi.spyOn>;

  beforeAll(async () => {
    const material = await mintNoiseStaticKeyPair();
    enrollment = {
      relayUrl: ORIGIN,
      burrowId: testRoutingId(),
      burrowToken: 'tok',
      origin: ORIGIN,
      rpId: RP_ID,
      label: LABEL,
      noiseStaticPrivateKey: material.privateKeyPkcs8,
      noiseStaticPublicKey: material.publicKey,
    };
    authenticator = await createTestAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  });

  beforeEach(() => {
    approvals = [];
    sessions = [];
    clock = createTestClock(1_700_000_000_000);
    warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    burrow?.stop();
    warn.mockRestore();
  });

  function makeBurrow(directPeering: DirectPeering): BurrowRuntime {
    burrow = new BurrowRuntime({
      enrollment,
      reconnect: false,
      directPeering,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [] as BurrowAclRecord[],
      saveAcl: () => {},
      requestApproval: (pending) => approvals.push(pending),
      dismissApproval: () => {},
      createSession: ({ send }) => {
        const entry = { handled: [] as unknown[], disposed: false, send };
        sessions.push(entry);
        return {
          handle: (data) => entry.handled.push(data),
          dispose: () => {
            entry.disposed = true;
          },
        } satisfies RemoteApiSessionLike;
      },
      now: clock.now,
      setTimer: clock.setTimer,
    });
    burrow.start();
    socket.open();
    return burrow;
  }

  /** Under Local networks: a peer factory on the fake network, and the LAN-only hold. */
  function localNetworks(network = new FakeDirectNetwork()): FakeDirectNetwork {
    makeBurrow({ createPeer: () => network.createAnswerer(), pathPolicy: lanOnlyPolicy() });
    return network;
  }

  async function pairClient(clientId: string): Promise<NoiseKeyPair> {
    clock.advance(1_000);
    const invitation = await burrow.mintInvitation(randomBase64Url(32), clock.now() + DEFAULT_PAIRING_TTL_MS);
    const before = approvals.length;
    const { session, clientStatic } = await pairThroughSocket({
      socket,
      burrowId: enrollment.burrowId,
      clientId,
      invitation,
      authenticator,
      until: () => approvals.length > before,
    });
    approvals.at(-1)!.approve('42');
    await readOutcome(socket, session, 'pairing', invitation.inviteId);
    return clientStatic;
  }

  /** Pair and connect `clientId`, answering its session and the outcome it read. */
  async function connect(clientId = 'c1') {
    const clientStatic = await pairClient(clientId);
    clock.advance(1_000);
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnectionSession({
      socket,
      burrowId: enrollment.burrowId,
      clientId,
      connectionId,
      clientStatic,
      burrowStaticPublicKey: enrollment.noiseStaticPublicKey!,
    });
    const binding: PresenceBinding = {
      kind: 'connection',
      burrowId: enrollment.burrowId,
      connectionId,
      burrowChallenge,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: authenticator.credentialId,
    };
    send(clientId, connectionId, session.sendControl({ presence: await presenceProofFor(authenticator, binding) }));
    const outcome = await readOutcome(socket, session, 'connection', connectionId);
    return { session, connectionId, clientId, outcome };
  }

  function send(clientId: string, connectionId: string, ciphertext: Uint8Array): void {
    sendE2eFrame(socket, {
      clientId,
      burrowId: enrollment.burrowId,
      kind: 'connection',
      id: connectionId,
      step: 'transport',
      ct: toBase64Url(ciphertext),
    });
  }

  /** One protocol-v1 request on the relay. */
  function relayHello(live: { session: NoiseTransportSession; connectionId: string; clientId: string }): void {
    for (const ciphertext of live.session.sendApp(utf8Encode(JSON.stringify({ requestId: 'r1', method: 'hello' })))) {
      send(live.clientId, live.connectionId, ciphertext);
    }
  }

  /** The control message the Burrow sent last on `live`'s session. */
  function lastControl(live: { session: NoiseTransportSession; connectionId: string }, index: number) {
    return readOutcome(socket, live.session, 'connection', live.connectionId, index);
  }

  const transportCount = (connectionId: string) =>
    e2eFramesFor(socket, 'connection', connectionId, 'transport').length;

  it('says so in the outcome, and ends a session whose application message crosses the relay, unread and with the goodbye', async () => {
    localNetworks();
    const live = await connect();
    expect(live.outcome).toEqual({ ok: true, burrowLabel: LABEL, directOnly: true });

    // A keepalive on the relay is no application message: the session stays.
    send(live.clientId, live.connectionId, live.session.sendKeepalive());
    await settle();
    expect(burrow.establishedSessionCount).toBe(1);

    relayHello(live);
    await settle();
    expect(sessions[0]!.handled).toEqual([]);
    expect(sessions[0]!.disposed).toBe(true);
    expect(burrow.establishedSessionCount).toBe(0);
    expect(await lastControl(live, 1)).toEqual(SESSION_END_V1);
  });

  it('carries protocol-v1 once the direct path does, past the deadline', async () => {
    const network = localNetworks();
    const live = await connect();
    const path = await openDirectPath({
      socket,
      burrowId: enrollment.burrowId,
      clientId: live.clientId,
      connectionId: live.connectionId,
      session: live.session,
      network,
      setTimer: clock.setTimer,
    });
    for (const ciphertext of live.session.sendApp(utf8Encode(JSON.stringify({ requestId: 'r1', method: 'hello' })))) {
      path.peer.send(ciphertext);
    }
    await settle();
    expect(sessions[0]!.handled).toEqual([{ requestId: 'r1', method: 'hello' }]);

    clock.advance(DIRECT_ONLY_DEADLINE_MS);
    await settle();
    expect(sessions[0]!.disposed).toBe(false);
    expect(burrow.establishedSessionCount).toBe(1);
  });

  it('ends a session the direct path has not carried by the deadline, with the goodbye', async () => {
    localNetworks();
    const live = await connect();

    clock.advance(DIRECT_ONLY_DEADLINE_MS - 1);
    expect(burrow.establishedSessionCount).toBe(1);
    clock.advance(1);
    expect(burrow.establishedSessionCount).toBe(0);
    expect(sessions[0]!.disposed).toBe(true);
    expect(await lastControl(live, 1)).toEqual(SESSION_END_V1);
  });

  it('ends a session whose attempt was given up, after the decline', async () => {
    // A host with no peer factory declines every offer, and there is no relay
    // left for a direct-only session to stay on.
    makeBurrow({ createPeer: null, pathPolicy: lanOnlyPolicy() });
    const live = await connect();
    send(
      live.clientId,
      live.connectionId,
      live.session.sendControl({ v: 1, t: 'direct-offer', sdp: 'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' }),
    );
    await settle();

    expect(await lastControl(live, 1)).toEqual({ v: 1, t: 'direct-decline' });
    expect(await lastControl(live, 2)).toEqual(SESSION_END_V1);
    expect(burrow.establishedSessionCount).toBe(0);
  });

  it('ends a session whose path the policy refuses, with no goodbye on that path', async () => {
    const network = localNetworks(new FakeDirectNetwork({ selectedPair: OFF_LAN_PAIR }));
    const live = await connect();
    const before = transportCount(live.connectionId);
    await openDirectPath({
      socket,
      burrowId: enrollment.burrowId,
      clientId: live.clientId,
      connectionId: live.connectionId,
      session: live.session,
      network,
      setTimer: clock.setTimer,
    }).catch(() => undefined);
    await settle();

    expect(burrow.establishedSessionCount).toBe(0);
    expect(sessions[0]!.disposed).toBe(true);
    // The answer, and nothing after it: no goodbye followed the refusal. (The
    // test's own wait for the Burrow's switch is what timed out above.)
    expect(transportCount(live.connectionId)).toBe(before + 1);
  });

  it('relays protocol-v1 as ever without a path policy, and says nothing of the direct path in the outcome', async () => {
    makeBurrow({ createPeer: null });
    const live = await connect();
    expect(live.outcome).toEqual({ ok: true, burrowLabel: LABEL });
    relayHello(live);
    await settle();
    expect(sessions[0]!.handled).toEqual([{ requestId: 'r1', method: 'hello' }]);
    clock.advance(DIRECT_ONLY_DEADLINE_MS);
    expect(burrow.establishedSessionCount).toBe(1);
  });

  it('tells every session goodbye as it stops', async () => {
    makeBurrow({ createPeer: null });
    const first = await connect('c1');
    const second = await connect('c2');
    burrow.stop();
    expect(await lastControl(first, 1)).toEqual(SESSION_END_V1);
    expect(await lastControl(second, 1)).toEqual(SESSION_END_V1);
    expect(sessions.every((entry) => entry.disposed)).toBe(true);
    expect(socket.readyState).toBe(3);
  });
});

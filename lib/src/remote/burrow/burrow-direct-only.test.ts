/**
 * A paired phone's session under a held path policy — Local networks
 * (`docs/specs/remote-network.md` -> "Local networks"): the outcome says it is
 * direct-only, an application message off the relay ends it unread, and so do
 * a given-up attempt and the direct deadline, each with the goodbye — which,
 * where the path was why, says so and names the address the Burrow can, as
 * the refusal it reports does. Without a path policy the relay carries
 * protocol-v1 as ever. And every `stop()` tells its sessions so.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PAIRING_TTL_MS,
  DIRECT_ANSWER_TIMEOUT_MS,
  DIRECT_BUFFER_HIGH,
  DIRECT_ONLY_DEADLINE_MS,
  PRESENCE_WINDOW,
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
import { DirectPeer, type DirectPathPolicy, type DirectPeering } from '../direct/direct-peer';
import type { PathRefusal } from '../direct/path-refusal';
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
  let refusals: PathRefusal[];

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
    refusals = [];
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
      onPathRefused: (refusal) => refusals.push(refusal),
      now: clock.now,
      setTimer: clock.setTimer,
    });
    burrow.start();
    socket.open();
    return burrow;
  }

  /** Under Local networks: a peer factory on the fake network, and the LAN-only hold. */
  function localNetworks(
    network = new FakeDirectNetwork(),
    pathPolicy: DirectPathPolicy = lanOnlyPolicy(),
  ): FakeDirectNetwork {
    makeBurrow({ createPeer: () => network.createAnswerer(), pathPolicy });
    return network;
  }

  /** The phone's offer on the relay, and the Burrow's answer read back; the channel is the network's to open. */
  async function offerOnly(
    live: { session: NoiseTransportSession; connectionId: string; clientId: string },
    network: FakeDirectNetwork,
  ): Promise<void> {
    const phone = new DirectPeer({
      peer: network.createOfferer(),
      setTimer: clock.setTimer,
      handlers: { onOpen: () => {}, onFrame: () => {}, onClosed: () => {}, onViolation: () => {} },
    });
    const sdp = await phone.offer();
    send(live.clientId, live.connectionId, live.session.sendControl({ v: 1, t: 'direct-offer', sdp }));
    expect(await lastControl(live, 1)).toMatchObject({ t: 'direct-answer' });
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
  /** Pair, then connect with a fresh proof or — with `window` — by riding the presence window. */
  async function connect(clientId = 'c1', { window = false }: { window?: boolean } = {}) {
    const clientStatic = await pairClient(clientId);
    clock.advance(1_000);
    const connectionId = testRoutingId();
    const { session, burrowChallenge, offer } = await openConnectionSession({
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
    const presence = window ? PRESENCE_WINDOW : await presenceProofFor(authenticator, binding);
    send(clientId, connectionId, session.sendControl({ presence }));
    const outcome = await readOutcome(socket, session, 'connection', connectionId);
    return { session, connectionId, clientId, offer, outcome };
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

  it('says so to a connection that rode the presence window, which asked for no proof', async () => {
    localNetworks();
    expect(await connect('c1', { window: true })).toMatchObject({
      offer: PRESENCE_WINDOW,
      outcome: { ok: true, burrowLabel: LABEL, directOnly: true },
    });
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
    // A phone that never offered says nothing about the path.
    expect(await lastControl(live, 1)).toEqual(SESSION_END_V1);
    expect(refusals).toEqual([]);
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

  it('ends a session whose path the policy refuses with a goodbye on the relay naming the pair’s remote end', async () => {
    const network = localNetworks(
      new FakeDirectNetwork({ selectedPair: OFF_LAN_PAIR }),
      // Offered, and outranked: the pair the ICE agent reported is evidence.
      lanOnlyPolicy({ reportedAddress: () => '203.0.113.7' }),
    );
    const live = await connect();
    const before = transportCount(live.connectionId);
    const { signals } = await openDirectPath({
      socket,
      burrowId: enrollment.burrowId,
      clientId: live.clientId,
      connectionId: live.connectionId,
      session: live.session,
      network,
      setTimer: clock.setTimer,
    });
    await settle();

    expect(burrow.establishedSessionCount).toBe(0);
    expect(sessions[0]!.disposed).toBe(true);
    // The answer, then the goodbye — on the relay, since the refused channel
    // never carried this session.
    expect(transportCount(live.connectionId)).toBe(before + 2);
    expect(signals.at(-1)).toEqual({
      ...SESSION_END_V1,
      reason: 'network-not-allowed',
      address: OFF_LAN_PAIR.remote,
      addressSource: 'observed',
    });
    expect(refusals).toEqual([
      { at: clock.now(), kind: 'path-refused', end: 'remote', address: OFF_LAN_PAIR.remote, addressSource: 'observed' },
    ]);
  });

  it('ends a session whose own end the policy refuses with a goodbye naming no address, and records this end', async () => {
    const network = localNetworks(
      new FakeDirectNetwork({ selectedPair: { local: '10.0.0.2', remote: '10.0.0.3' } }),
      // The phone offered one, and is not the end refused: nothing names it.
      lanOnlyPolicy({ reportedAddress: () => '203.0.113.7' }),
    );
    const live = await connect();
    const { signals } = await openDirectPath({
      socket,
      burrowId: enrollment.burrowId,
      clientId: live.clientId,
      connectionId: live.connectionId,
      session: live.session,
      network,
      setTimer: clock.setTimer,
    });
    await settle();

    expect(burrow.establishedSessionCount).toBe(0);
    expect(signals.at(-1)).toEqual({ ...SESSION_END_V1, reason: 'network-not-allowed' });
    expect(refusals).toEqual([{ at: clock.now(), kind: 'path-refused', end: 'local', localAddress: '10.0.0.2' }]);
  });

  it('names the address the phone’s offer reported where no pair formed, as a refusal', async () => {
    const offered: string[] = [];
    const network = localNetworks(
      new FakeDirectNetwork({ opening: 'never' }),
      lanOnlyPolicy({
        reportedAddress: (sdp) => {
          offered.push(sdp);
          return '203.0.113.7';
        },
      }),
    );
    const live = await connect();
    await offerOnly(live, network);
    // Read off the offer as the phone sent it.
    expect(offered).toHaveLength(1);
    expect(offered[0]).toContain('a=candidate:');

    clock.advance(DIRECT_ANSWER_TIMEOUT_MS);
    await settle();
    expect(burrow.establishedSessionCount).toBe(0);
    expect(await lastControl(live, 2)).toEqual({
      ...SESSION_END_V1,
      reason: 'network-not-allowed',
      address: '203.0.113.7',
      addressSource: 'reported',
    });
    expect(refusals).toEqual([
      { at: clock.now(), kind: 'given-up', end: 'remote', address: '203.0.113.7', addressSource: 'reported' },
    ]);
  });

  it('says the path ended a session it tried and missed the deadline on, with no address to name', async () => {
    const network = localNetworks(new FakeDirectNetwork({ opening: 'never' }));
    const live = await connect();
    // An offer late enough that the session's deadline comes before the answer's.
    clock.advance(DIRECT_ONLY_DEADLINE_MS - 2_000);
    await offerOnly(live, network);
    expect(burrow.establishedSessionCount).toBe(1);
    clock.advance(2_000);
    await settle();
    expect(burrow.establishedSessionCount).toBe(0);
    expect(refusals).toEqual([{ at: clock.now(), kind: 'deadline' }]);
    expect(await lastControl(live, 2)).toEqual({ ...SESSION_END_V1, reason: 'network-not-allowed' });
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

  it('stops with no flush timer behind it, a direct session busy with output included', async () => {
    const network = new FakeDirectNetwork();
    makeBurrow({ createPeer: () => network.createAnswerer() });
    const live = await connect();
    // The test's own end on real timers, so the clock counts the Burrow's alone.
    await openDirectPath({
      socket,
      burrowId: enrollment.burrowId,
      clientId: live.clientId,
      connectionId: live.connectionId,
      session: live.session,
      network,
    });
    // A goodbye that cannot leave at once: an ended session would hold the
    // channel open behind a flush timer.
    network.answererChannel!.bufferedAmount = DIRECT_BUFFER_HIGH;

    burrow.stop();
    expect(clock.armed).toBe(0);
    expect(sessions[0]!.disposed).toBe(true);
  });
});

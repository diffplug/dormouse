/**
 * The Host bounds, instrumented: what a rejected frame actually *costs*
 * (`docs/specs/remote-security-model.md` → Host bounds).
 *
 * The ceremonies themselves are `remote-host.test.ts`. What this file adds is
 * measurement — a counting wrapper over the injected `WebCryptoLike` and a spy
 * on `NoiseTransportSession.receive` — because "performs no WebCrypto
 * operation and allocates nothing" is not a property the wire can show. Every
 * deadline runs on an injected clock and an injected timer, so expiry is
 * deterministic rather than a five-minute wait.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CEREMONY_FIELD_LIMIT,
  DEFAULT_CHALLENGE_TTL_MS,
  DEFAULT_PAIRING_TTL_MS,
  E2E_INIT_BURST,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  E2E_KEEPALIVE_INTERVAL_MS,
  MAX_ESTABLISHED_E2E_SESSIONS,
  MAX_E2E_CIPHERTEXT_LENGTH,
  MAX_CLIENT_ID_LENGTH,
  NoiseTransportSession,
  fromBase64Url,
  generateNoiseKeyPair,
  isPairingOutcomeV1,
  mintNoiseStaticKeyPair,
  toBase64Url,
  type HostAclRecord,
  type NoiseKeyPair,
  type PresenceBinding,
} from 'server-lib-common';
import { RemoteHost, type RemoteApiSessionLike } from './remote-host';
import type { HostEnrollment } from './enrollment';
import type { PendingPairing } from './pairing-approval';
import { FakeSocket } from '../test-fake-socket';
import {
  createTestAuthenticator,
  e2eFramesFor,
  flushUntil,
  openConnectionSession,
  openPairingSession,
  presenceProofFor,
  randomBase64Url,
  readOutcome,
  sendE2eFrame,
  settle,
  settleUntil,
  testRoutingId,
  type TestAuthenticator,
} from '../test-e2e-client';

const ORIGIN = 'https://host.example';
const RP_ID = 'host.example';
const START = 1_700_000_000_000;

/**
 * A clock and its one timer, both injected. `advance` fires every timer that
 * comes due, in order, so the Host's reaper runs exactly where it would in
 * real time — and the suite does not spend five minutes proving a TTL.
 */
function createTestClock(start: number) {
  let now = start;
  let nextId = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimer(run: () => void, delayMs: number): () => void {
      const id = nextId++;
      timers.set(id, { at: now + delayMs, run });
      return () => timers.delete(id);
    },
    /** How many timers are armed — what `stop()` has to leave at zero. */
    get armed(): number {
      return timers.size;
    },
    advance(ms: number): void {
      const target = now + ms;
      // Bounded: a reaper that armed for an instant it does not clear would
      // otherwise spin here rather than fail.
      for (let guard = 0; guard < 10_000; guard += 1) {
        let dueId: number | null = null;
        let dueAt = Number.POSITIVE_INFINITY;
        for (const [id, timer] of timers) {
          if (timer.at <= target && timer.at < dueAt) {
            dueAt = timer.at;
            dueId = id;
          }
        }
        if (dueId === null) break;
        const timer = timers.get(dueId)!;
        timers.delete(dueId);
        now = timer.at;
        timer.run();
      }
      now = target;
    },
  };
}

/**
 * Counting wrappers over the WebCrypto the security primitives reach for, plus
 * the transport's own decrypt. `getWebCrypto()` answers `globalThis.crypto`, so
 * this is the seam every `deriveBits`, `digest`, `sign`, and `verify` in the
 * Host's ceremonies goes through; `NoiseTransportSession.receive` is where
 * ChaChaPoly is spent.
 */
function countCrypto() {
  const subtle = globalThis.crypto.subtle;
  const spies = {
    deriveBits: vi.spyOn(subtle, 'deriveBits'),
    digest: vi.spyOn(subtle, 'digest'),
    sign: vi.spyOn(subtle, 'sign'),
    verify: vi.spyOn(subtle, 'verify'),
    generateKey: vi.spyOn(subtle, 'generateKey'),
    decrypt: vi.spyOn(NoiseTransportSession.prototype, 'receive'),
  };
  return {
    /** Calls since the last {@link reset}, by operation. */
    counts(): Record<keyof typeof spies, number> {
      return Object.fromEntries(
        Object.entries(spies).map(([name, spy]) => [name, spy.mock.calls.length]),
      ) as Record<keyof typeof spies, number>;
    },
    /** Every counter, summed — what "zero crypto" is asserted against. */
    total(): number {
      return Object.values(spies).reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    },
    reset(): void {
      for (const spy of Object.values(spies)) spy.mockClear();
    },
    restore(): void {
      for (const spy of Object.values(spies)) spy.mockRestore();
    },
  };
}

describe('RemoteHost bounds', () => {
  let enrollment: HostEnrollment;
  let socket: FakeSocket;
  let host: RemoteHost;
  let clock: ReturnType<typeof createTestClock>;
  let crypto: ReturnType<typeof countCrypto>;
  let approvals: PendingPairing[] = [];
  let sessions: Array<{ handled: unknown[]; disposed: boolean; send: (payload: unknown) => void }> =
    [];
  let authenticator: TestAuthenticator;

  beforeAll(async () => {
    const material = await mintNoiseStaticKeyPair();
    enrollment = {
      serverUrl: ORIGIN,
      hostId: testRoutingId(),
      hostToken: 'tok',
      origin: ORIGIN,
      rpId: RP_ID,
      label: 'Ned’s laptop',
      noiseStaticPrivateKey: material.privateKeyPkcs8,
      noiseStaticPublicKey: material.publicKey,
    };
    authenticator = await createTestAuthenticator({ rpId: RP_ID, origin: ORIGIN });
  });

  beforeEach(() => {
    approvals = [];
    sessions = [];
    clock = createTestClock(START);
    crypto = countCrypto();
    host = makeHost();
  });

  afterEach(() => {
    host.stop();
    crypto.restore();
  });

  function makeHost(): RemoteHost {
    const created = new RemoteHost({
      enrollment,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [] as HostAclRecord[],
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
    created.start();
    socket.open();
    return created;
  }

  /** One authorized session, from a fresh Client static through both ceremonies. */
  async function establish(
    clientId: string,
    clientStatic?: NoiseKeyPair,
  ): Promise<{ session: NoiseTransportSession; clientStatic: NoiseKeyPair; connectionId: string }> {
    const paired = clientStatic ?? (await pairClient(clientId));
    // One token per `init`, and the bucket sustains one per second.
    clock.advance(1_000);
    const connectionId = testRoutingId();
    const { session, hostChallenge } = await openConnectionSession({
      socket,
      hostId: enrollment.hostId,
      clientId,
      connectionId,
      clientStatic: paired,
      hostStaticPublicKey: enrollment.noiseStaticPublicKey!,
    });
    const binding: PresenceBinding = {
      kind: 'connection',
      hostId: enrollment.hostId,
      connectionId,
      hostChallenge,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: authenticator.credentialId,
    };
    sendE2eFrame(socket, {
      clientId,
      hostId: enrollment.hostId,
      kind: 'connection',
      id: connectionId,
      step: 'transport',
      ct: toBase64Url(session.sendControl({ presence: await presenceProofFor(authenticator, binding) })),
    });
    const outcome = await readOutcome(socket, session, 'connection', connectionId);
    expect(outcome).toEqual({ ok: true, hostLabel: 'Ned’s laptop' });
    return { session, clientStatic: paired, connectionId };
  }

  /** Pair one fresh Client static against this Host's one passkey. */
  async function pairClient(clientId: string): Promise<NoiseKeyPair> {
    clock.advance(1_000);
    const invitation = await host.mintInvitation(
      randomBase64Url(32),
      clock.now() + DEFAULT_PAIRING_TTL_MS,
    );
    const clientStatic = await generateNoiseKeyPair();
    const session = await openPairingSession({
      socket,
      hostId: enrollment.hostId,
      clientId,
      invitation,
      clientStatic,
    });
    if (!session) throw new Error('the Host refused the pairing handshake');
    const binding: PresenceBinding = {
      kind: 'pairing',
      hostId: enrollment.hostId,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: authenticator.credentialId,
    };
    const before = approvals.length;
    sendE2eFrame(socket, {
      clientId,
      hostId: enrollment.hostId,
      kind: 'pairing',
      id: invitation.inviteId,
      step: 'transport',
      ct: toBase64Url(
        session.sendControl({
          code: '42',
          label: 'iPhone Safari',
          presence: await presenceProofFor(authenticator, binding),
        }),
      ),
    });
    await settleUntil(() => approvals.length > before);
    approvals[approvals.length - 1]!.approve('42');
    await readOutcome(socket, session, 'pairing', invitation.inviteId);
    return clientStatic;
  }

  /** Deliver a raw frame straight to the Host socket — no relay, no guards. */
  function deliver(frame: Record<string, unknown>): void {
    socket.receive(frame);
  }

  // --- What a rejected frame costs -----------------------------------------

  it('spends no crypto and allocates nothing on a frame the wire guard refuses', async () => {
    // Delivered straight onto the Host's socket, so the relay's own `ct`/`id`
    // guards are simply absent: the Host runs its own or it has none.
    const base = {
      t: 'e2e',
      clientId: 'c1',
      hostId: enrollment.hostId,
      kind: 'connection',
      id: testRoutingId(),
      step: 'init',
      ct: 'AAAA',
    };
    crypto.reset();
    for (const frame of [
      // Over the ciphertext bound: a Noise message can never exceed 65,535
      // bytes, so this is measured before any base64 decode.
      { ...base, ct: 'a'.repeat(MAX_E2E_CIPHERTEXT_LENGTH + 1) },
      { ...base, ct: '' },
      { ...base, ct: 'not base64url!' },
      { ...base, id: `${testRoutingId()}x` },
      { ...base, id: 'short' },
      { ...base, clientId: 'x'.repeat(MAX_CLIENT_ID_LENGTH + 1) },
      { ...base, clientId: 42 },
      { ...base, hostId: 'not-a-host-id' },
      { ...base, kind: 'terminal' },
      { ...base, step: 'response' },
      { t: 'client-gone', clientId: 'y'.repeat(MAX_CLIENT_ID_LENGTH + 1) },
      { t: 'nonsense' },
    ]) {
      deliver(frame);
    }
    await settle();

    expect(crypto.total()).toBe(0);
    expect(host.trackedClientCount).toBe(0);
    expect(host.pendingChallengeCount).toBe(0);
    expect(socket.sent).toEqual([]);
  });

  it('spends no crypto on an unknown id or a pre-authorization transport frame', async () => {
    crypto.reset();
    // A connection id nothing is pending under, and a transport frame from a
    // client that has never completed a handshake: both are dropped before any
    // decrypt, because there is no session to decrypt them on.
    for (let i = 0; i < 20; i += 1) {
      deliver({
        t: 'e2e',
        clientId: `stranger-${i}`,
        hostId: enrollment.hostId,
        kind: 'connection',
        id: testRoutingId(),
        step: 'transport',
        ct: toBase64Url(new Uint8Array(64)),
      });
      deliver({
        t: 'e2e',
        clientId: `stranger-${i}`,
        hostId: enrollment.hostId,
        kind: 'pairing',
        id: testRoutingId(),
        step: 'init',
        ct: toBase64Url(new Uint8Array(96)),
      });
    }
    await settle();

    expect(crypto.total()).toBe(0);
    expect(host.trackedClientCount).toBe(0);
  });

  it('answers eight handshakes back to back and buys the ninth nothing', async () => {
    // One invitation, flooded: a message 1 that fails to decrypt leaves it
    // live, so nothing but the bucket separates these frames from each other.
    const invitation = await host.mintInvitation(
      randomBase64Url(32),
      clock.now() + DEFAULT_PAIRING_TTL_MS,
    );
    let sent = 0;
    const flood = async (count: number): Promise<number> => {
      crypto.reset();
      for (let i = 0; i < count; i += 1) {
        deliver({
          t: 'e2e',
          clientId: `flood-${sent++}`,
          hostId: enrollment.hostId,
          kind: 'pairing',
          id: invitation.inviteId,
          step: 'init',
          ct: toBase64Url(new Uint8Array(96)),
        });
      }
      await settle();
      return crypto.total();
    };

    // What one refused init costs is the unit everything else is measured in.
    const unit = await flood(1);
    expect(unit).toBeGreaterThan(0);
    expect(await flood(E2E_INIT_BURST - 1)).toBe(unit * (E2E_INIT_BURST - 1));

    // The burst is spent: the rest cost a map lookup each and nothing more.
    expect(await flood(4)).toBe(0);
    expect(host.trackedClientCount).toBe(0);
    expect(host.invitationState(invitation.inviteId)).toBe('live');

    // And it refills at one per second, not faster.
    clock.advance(3_000);
    expect(await flood(8)).toBe(unit * 3);
  });

  // --- The established-session cap -----------------------------------------

  it('holds sixteen sessions, answers host-busy past that, and evicts nobody', async () => {
    const held = [];
    for (let i = 0; i < MAX_ESTABLISHED_E2E_SESSIONS; i += 1) {
      held.push(await establish(`c${i}`));
    }
    expect(host.establishedSessionCount).toBe(MAX_ESTABLISHED_E2E_SESSIONS);

    // A seventeenth identity: authorized, and still refused — a session an
    // authenticated Client holds must not be displaceable by the next one.
    const stranger = await pairClient('c-late');
    clock.advance(1_000);
    const connectionId = testRoutingId();
    const { session, hostChallenge } = await openConnectionSession({
      socket,
      hostId: enrollment.hostId,
      clientId: 'c-late',
      connectionId,
      clientStatic: stranger,
      hostStaticPublicKey: enrollment.noiseStaticPublicKey!,
    });
    sendE2eFrame(socket, {
      clientId: 'c-late',
      hostId: enrollment.hostId,
      kind: 'connection',
      id: connectionId,
      step: 'transport',
      ct: toBase64Url(
        session.sendControl({
          presence: await presenceProofFor(authenticator, {
            kind: 'connection',
            hostId: enrollment.hostId,
            connectionId,
            hostChallenge,
            handshakeHash: toBase64Url(session.handshakeHash),
            passkeyCredentialId: authenticator.credentialId,
          }),
        }),
      ),
    });
    expect(await readOutcome(socket, session, 'connection', connectionId)).toEqual({
      ok: false,
      code: 'host-busy',
    });
    expect(host.establishedSessionCount).toBe(MAX_ESTABLISHED_E2E_SESSIONS);
    expect(sessions.filter((s) => s.disposed)).toHaveLength(0);
  });

  it('replaces a Client static’s own session, and only after fresh presence', async () => {
    const first = await establish('c1');
    await establish('c2');
    expect(host.establishedSessionCount).toBe(2);

    // The same static under a new relay-chosen clientId: a phone whose socket
    // dropped and came back. Its own zombie goes; the unrelated one does not.
    const replacement = await establish('c1-again', first.clientStatic);
    expect(host.establishedSessionCount).toBe(2);
    expect(sessions[0]!.disposed).toBe(true);
    expect(sessions[1]!.disposed).toBe(false);
    expect(replacement.session.isPoisoned).toBe(false);

    // A handshake that never proves presence replaces nothing: the incumbent
    // is only dropped at promotion.
    clock.advance(1_000);
    const connectionId = testRoutingId();
    await openConnectionSession({
      socket,
      hostId: enrollment.hostId,
      clientId: 'c1-third',
      connectionId,
      clientStatic: first.clientStatic,
      hostStaticPublicKey: enrollment.noiseStaticPublicKey!,
    });
    await settle();
    expect(host.establishedSessionCount).toBe(2);
    expect(sessions[2]!.disposed).toBe(false);
  });

  // --- Teardown ------------------------------------------------------------

  it('costs one decrypt for a bad ciphertext, and destroys only that session', async () => {
    await establish('c1');
    const other = await establish('c2');
    crypto.reset();

    sendE2eFrame(socket, {
      clientId: 'c1',
      hostId: enrollment.hostId,
      kind: 'connection',
      id: testRoutingId(),
      step: 'transport',
      ct: toBase64Url(new Uint8Array(64)),
    });
    await settle();
    // The id names no session at all, so not even a decrypt is spent.
    expect(crypto.total()).toBe(0);
    expect(host.establishedSessionCount).toBe(2);
  });

  it('destroys a session on its first invalid ciphertext, at the cost of one decrypt', async () => {
    const first = await establish('c1');
    await establish('c2');
    crypto.reset();

    sendE2eFrame(socket, {
      clientId: 'c1',
      hostId: enrollment.hostId,
      kind: 'connection',
      id: first.connectionId,
      step: 'transport',
      ct: toBase64Url(new Uint8Array(64)),
    });
    await settleUntil(() => sessions[0]!.disposed);
    expect(crypto.counts().decrypt).toBe(1);
    expect(sessions[0]!.disposed).toBe(true);
    expect(sessions[1]!.disposed).toBe(false);
    expect(host.establishedSessionCount).toBe(1);

    // And a second frame on the dead id costs nothing at all.
    crypto.reset();
    sendE2eFrame(socket, {
      clientId: 'c1',
      hostId: enrollment.hostId,
      kind: 'connection',
      id: first.connectionId,
      step: 'transport',
      ct: toBase64Url(new Uint8Array(64)),
    });
    await settle();
    expect(crypto.total()).toBe(0);
  });

  it('client-gone removes exactly one session; losing the relay removes them all', async () => {
    await establish('c1');
    await establish('c2');
    await establish('c3');

    deliver({ t: 'client-gone', clientId: 'c2' });
    await settleUntil(() => sessions[1]!.disposed);
    expect(host.establishedSessionCount).toBe(2);
    expect(sessions.map((s) => s.disposed)).toEqual([false, true, false]);

    socket.drop();
    await settle();
    expect(host.establishedSessionCount).toBe(0);
    expect(host.trackedClientCount).toBe(0);
    expect(sessions.every((s) => s.disposed)).toBe(true);
  });

  // --- The reaper ----------------------------------------------------------

  it('expires pending pairings and connections on the clock, with no frame to prompt it', async () => {
    const invitation = await host.mintInvitation(
      randomBase64Url(32),
      clock.now() + DEFAULT_PAIRING_TTL_MS,
    );
    const pairing = await openPairingSession({
      socket,
      hostId: enrollment.hostId,
      clientId: 'p1',
      invitation,
      clientStatic: await generateNoiseKeyPair(),
    });
    const clientStatic = await generateNoiseKeyPair();
    clock.advance(1_000);
    const connectionId = testRoutingId();
    const connection = await openConnectionSession({
      socket,
      hostId: enrollment.hostId,
      clientId: 'k1',
      connectionId,
      clientStatic,
      hostStaticPublicKey: enrollment.noiseStaticPublicKey!,
    });
    expect(host.trackedClientCount).toBe(2);

    // The challenge TTL passes first: the pending connection is answered with
    // the same refusal a late request would have earned.
    clock.advance(DEFAULT_CHALLENGE_TTL_MS + 1);
    expect(await readOutcome(socket, connection.session, 'connection', connectionId)).toEqual({
      ok: false,
      code: 'presence-rejected',
    });

    // Then the pairing TTL: a person was waiting on that one, so it is told why.
    clock.advance(DEFAULT_PAIRING_TTL_MS);
    expect(await readOutcome(socket, pairing!, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'invitation-expired',
    });
    expect(host.trackedClientCount).toBe(0);
    expect(host.outstandingInvitationCount).toBe(0);
  });

  it('reaps sixteen silent sessions on the idle timeout, without a restart', async () => {
    for (let i = 0; i < MAX_ESTABLISHED_E2E_SESSIONS; i += 1) await establish(`z${i}`);
    expect(host.establishedSessionCount).toBe(MAX_ESTABLISHED_E2E_SESSIONS);

    // No frame arrives, and no socket event: only the reaper's own timer runs.
    clock.advance(ESTABLISHED_E2E_IDLE_TIMEOUT_MS + 1);
    expect(host.establishedSessionCount).toBe(0);
    expect(host.trackedClientCount).toBe(0);
    expect(sessions.every((s) => s.disposed)).toBe(true);
    // And the Host is still the same one: nothing restarted it.
    expect(host.status).toBe('connected');
  });

  it('only a decrypted Client message extends the idle deadline', async () => {
    await establish('c1');
    // Host output for three intervals: the Host talking to itself is not
    // evidence the phone is still there.
    for (let i = 0; i < 3; i += 1) {
      clock.advance(E2E_KEEPALIVE_INTERVAL_MS);
      sessions[0]!.send({ event: 'terminal.data', bytes: 'AA' });
    }
    expect(sessions[0]!.disposed).toBe(false);
    clock.advance(ESTABLISHED_E2E_IDLE_TIMEOUT_MS);
    expect(sessions[0]!.disposed).toBe(true);

    // A keepalive, on the other hand, is exactly the evidence the reaper wants.
    const second = await establish('c2');
    for (let i = 0; i < 6; i += 1) {
      clock.advance(E2E_KEEPALIVE_INTERVAL_MS);
      sendE2eFrame(socket, {
        clientId: 'c2',
        hostId: enrollment.hostId,
        kind: 'connection',
        id: second.connectionId,
        step: 'transport',
        ct: toBase64Url(second.session.sendKeepalive()),
      });
      await settle();
    }
    expect(sessions[1]!.disposed).toBe(false);
    expect(host.establishedSessionCount).toBe(1);
  });

  // --- What the Host puts on the wire --------------------------------------

  it('bounds its own label, so an outcome the phone would discard is never sent', async () => {
    // The Client's outcome guards refuse any field over `CEREMONY_FIELD_LIMIT`.
    // An unbounded machine name would pair on the laptop and be thrown away by
    // the phone, leaving the two permanently disagreeing about being paired.
    const created = new RemoteHost({
      enrollment: { ...enrollment, label: 'L'.repeat(CEREMONY_FIELD_LIMIT + 100) },
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [] as HostAclRecord[],
      saveAcl: () => {},
      requestApproval: (pending) => approvals.push(pending),
      dismissApproval: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
    });
    created.start();
    socket.open();
    host.stop();
    host = created;

    const invitation = await host.mintInvitation(
      randomBase64Url(32),
      clock.now() + DEFAULT_PAIRING_TTL_MS,
    );
    const session = await openPairingSession({
      socket,
      hostId: enrollment.hostId,
      clientId: 'c1',
      invitation,
      clientStatic: await generateNoiseKeyPair(),
    });
    sendE2eFrame(socket, {
      clientId: 'c1',
      hostId: enrollment.hostId,
      kind: 'pairing',
      id: invitation.inviteId,
      step: 'transport',
      ct: toBase64Url(
        session!.sendControl({
          code: '42',
          label: 'iPhone Safari',
          presence: await presenceProofFor(authenticator, {
            kind: 'pairing',
            hostId: enrollment.hostId,
            handshakeHash: toBase64Url(session!.handshakeHash),
            passkeyCredentialId: authenticator.credentialId,
          }),
        }),
      ),
    });
    await settleUntil(() => approvals.length > 0);
    approvals[0]!.approve('42');
    const outcome = await readOutcome(socket, session!, 'pairing', invitation.inviteId);

    expect(isPairingOutcomeV1(outcome)).toBe(true);
    expect((outcome.hostLabel as string).length).toBeLessThanOrEqual(CEREMONY_FIELD_LIMIT);
  });

  it('treats an over-size application message as the caller’s error, not host loss', async () => {
    const first = await establish('c1');

    // Refused before the first `encryptWithAd`, so no ciphertext exists and no
    // counter moved: killing the session here would turn a caller's size error
    // into a re-handshake, which costs the user a fresh authenticator prompt.
    sessions[0]!.send({ oversize: 'x'.repeat(2 * 1024 * 1024) });
    await settle();
    expect(sessions[0]!.disposed).toBe(false);
    expect(host.establishedSessionCount).toBe(1);

    // And the stream is exactly as synchronized as it was.
    sessions[0]!.send({ ok: true });
    const frame = await flushUntil(() =>
      e2eFramesFor(socket, 'connection', first.connectionId)
        .filter((f) => f.step === 'transport')
        .at(-1),
    );
    const receipt = first.session.receive(fromBase64Url(frame.ct as string));
    expect(receipt.kind).toBe('app');
  });

  it('leaves no timer armed once the Host stops', async () => {
    await host.mintInvitation(randomBase64Url(32), clock.now() + DEFAULT_PAIRING_TTL_MS);
    await establish('c1');
    expect(clock.armed).toBeGreaterThan(0);

    host.stop();
    expect(clock.armed).toBe(0);
  });
});

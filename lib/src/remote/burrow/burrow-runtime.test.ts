/**
 * The Burrow's two end-to-end ceremonies, driven by a **real** Noise IK initiator
 * over the fake relay socket: no ceremony step is stubbed, so a test that
 * passes here would pass against a real phone
 * (`docs/specs/remote-security-model.md` → Pairing, Connection, Burrow bounds).
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_PAIRING_TTL_MS,
  DEFAULT_CHALLENGE_TTL_MS,
  MAX_TOKENS_PER_BURROW,
  NoiseTransportSession,
  WS_CLOSE_BURROW_REPLACED,
  createNoiseInitiator,
  e2eConnectionPrologue,
  fromBase64Url,
  generateNoiseKeyPair,
  mintNoiseStaticKeyPair,
  pairingInvitationPrologue,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type BurrowAclRecord,
  type NoiseKeyPair,
  type PairingInvitation,
  type PresenceBinding,
  type PresenceProofV1,
} from 'remote-lib-common';
import { BurrowRuntime, type RemoteApiSessionLike, type BurrowOptions } from './burrow-runtime';
import type { BurrowEnrollment } from './enrollment';
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

const ORIGIN = 'https://burrow-machine.example';
const RP_ID = 'burrow.example';
const BURROW_LABEL = 'Ned’s laptop';
const ACCOUNT = 'owner';

/** One passkey for this Burrow's RP, from the shared driver. */
const newAuthenticator = (): Promise<TestAuthenticator> =>
  createTestAuthenticator({ rpId: RP_ID, origin: ORIGIN });

describe('BurrowRuntime end-to-end ceremonies', () => {
  let enrollment: BurrowEnrollment;
  let socket: FakeSocket;
  let burrow: BurrowRuntime;
  let savedRecords: BurrowAclRecord[] = [];
  let approvals: PendingPairing[] = [];
  let dismissed: string[] = [];
  let invitationEvents: Array<{ inviteId: string; state: string; outcome?: string }> = [];
  // `outcome` is omitted rather than `undefined` where there is none, so the
  // cases that are only about a state still compare against a two-field object.
  const recordInvitation: NonNullable<BurrowOptions['onInvitationChanged']> = (
    inviteId,
    state,
    outcome,
  ) => {
    invitationEvents.push(outcome ? { inviteId, state, outcome } : { inviteId, state });
  };
  let sessions: Array<{ handled: unknown[]; disposed: boolean; send: (payload: unknown) => void }> =
    [];
  let clock = 1_700_000_000_000;
  let burrows: BurrowRuntime[] = [];

  beforeAll(async () => {
    const material = await mintNoiseStaticKeyPair();
    enrollment = {
      relayUrl: ORIGIN,
      burrowId: testRoutingId(),
      burrowToken: 'tok',
      origin: ORIGIN,
      rpId: RP_ID,
      label: BURROW_LABEL,
      noiseStaticPrivateKey: material.privateKeyPkcs8,
      noiseStaticPublicKey: material.publicKey,
    };
  });

  beforeEach(() => {
    savedRecords = [];
    approvals = [];
    dismissed = [];
    invitationEvents = [];
    sessions = [];
    clock = 1_700_000_000_000;
    burrows = [];
  });

  // These cases run the reaper on real timers, so a Burrow left running holds a
  // five-minute `setTimeout` for every invitation the case minted.
  afterEach(() => {
    for (const created of burrows) created.stop();
  });

  function makeBurrow(
    loadAcl: () => BurrowAclRecord[] = () => [],
    options: { withSession?: boolean } = {},
  ): BurrowRuntime {
    const withSession = options.withSession ?? true;
    const created = new BurrowRuntime({
      enrollment,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl,
      saveAcl: (_burrowId, records) => {
        savedRecords = [...records];
      },
      requestApproval: (pending) => approvals.push(pending),
      dismissApproval: (clientId) => dismissed.push(clientId),
      onInvitationChanged: recordInvitation,
      createSession: withSession
        ? ({ send }) => {
            const entry = { handled: [] as unknown[], disposed: false, send };
            sessions.push(entry);
            return {
              handle: (data) => entry.handled.push(data),
              dispose: () => {
                entry.disposed = true;
              },
            } satisfies RemoteApiSessionLike;
          }
        : undefined,
      now: () => clock,
    });
    created.start();
    socket.open();
    burrow = created;
    burrows.push(created);
    return created;
  }

  /** The Burrow's outgoing `e2e` frames for one ceremony, in order. */
  function e2eFrames(kind: string, id: string): Array<Record<string, unknown>> {
    return e2eFramesFor(socket, kind, id);
  }

  function sendE2e(
    clientId: string,
    kind: 'pairing' | 'connection',
    id: string,
    step: 'init' | 'transport',
    ct: string,
  ): void {
    sendE2eFrame(socket, { clientId, burrowId: enrollment.burrowId, kind, id, step, ct });
  }

  // --- Pairing -------------------------------------------------------------

  async function mintInvitation(): Promise<PairingInvitation> {
    return await burrow.mintInvitation(randomBase64Url(32), clock + DEFAULT_PAIRING_TTL_MS);
  }

  /** Run the pairing IK handshake and return the Client's transport session. */
  function openPairing(
    clientId: string,
    invitation: PairingInvitation,
    clientStatic: NoiseKeyPair,
  ): Promise<NoiseTransportSession | null> {
    return openPairingSession({
      socket,
      burrowId: enrollment.burrowId,
      clientId,
      invitation,
      clientStatic,
    });
  }

  /** The full pairing up to the modal: handshake, request, surfaced approval. */
  async function requestPairing(
    clientId: string,
    authenticator: TestAuthenticator,
    options: { code?: string; label?: string; invitation?: PairingInvitation } = {},
  ) {
    const invitation = options.invitation ?? (await mintInvitation());
    const clientStatic = await generateNoiseKeyPair();
    const session = await openPairing(clientId, invitation, clientStatic);
    if (!session) throw new Error('the Burrow refused the pairing handshake');
    const code = options.code ?? '42';
    const binding: PresenceBinding = {
      kind: 'pairing',
      burrowId: enrollment.burrowId,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: authenticator.credentialId,
    };
    const presence = await presenceProofFor(authenticator, binding);
    const approvalsBefore = approvals.length;
    const framesBefore = e2eFrames('pairing', invitation.inviteId).length;
    sendE2e(
      clientId,
      'pairing',
      invitation.inviteId,
      'transport',
      toBase64Url(session.sendControl({ code, label: options.label ?? 'iPhone Safari', presence })),
    );
    // Either a modal opened or the Burrow answered; both mean it is done thinking.
    await settleUntil(
      () =>
        approvals.length > approvalsBefore ||
        e2eFrames('pairing', invitation.inviteId).length > framesBefore,
    );
    return { invitation, clientStatic, session, code, presence, binding };
  }

  /** Decrypt the outcome the Burrow sent last on this ceremony. */
  function outcome(
    session: NoiseTransportSession,
    kind: string,
    id: string,
  ): Promise<Record<string, unknown>> {
    return readOutcome(socket, session, kind, id);
  }

  it('pairs: handshake, presence proof, typed code, one ACL record', async () => {
    makeBurrow();
    const authenticator = await newAuthenticator();
    const { invitation, clientStatic, session, code } = await requestPairing('c1', authenticator);

    // Reserved the moment a valid message 1 decrypted, so the QR panel can stop
    // offering a code a phone is already using.
    expect(burrow.invitationState(invitation.inviteId)).toBe('reserved');
    expect(invitationEvents).toContainEqual({ inviteId: invitation.inviteId, state: 'reserved' });

    // The modal gets the label and nothing else: no code, no key, no proof.
    expect(approvals).toHaveLength(1);
    const pending = approvals[0]!;
    expect(pending.label).toBe('iPhone Safari');
    expect(Object.keys(pending).sort()).toEqual([
      'approve',
      'clientId',
      'deny',
      'label',
      'pairingId',
      'requestedAt',
    ]);

    pending.approve(code);
    const answer = await outcome(session, 'pairing', invitation.inviteId);
    expect(answer).toMatchObject({
      ok: true,
      burrowStaticPublicKey: enrollment.noiseStaticPublicKey,
      burrowLabel: BURROW_LABEL,
      accountId: ACCOUNT,
      passkeyCredentialId: authenticator.credentialId,
    });
    expect(typeof answer.deliveryId).toBe('string');

    // One record, binding the passkey to the Client static IK authenticated —
    // never to anything the payload merely claimed.
    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0]).toMatchObject({
      burrowId: enrollment.burrowId,
      accountId: ACCOUNT,
      passkeyCredentialId: authenticator.credentialId,
      clientStaticPublicKey: toBase64Url(clientStatic.publicKey),
      deliveryId: answer.deliveryId,
      label: 'iPhone Safari',
      revokedAt: null,
    });
    // The invitation is spent by the outcome, whichever way it went.
    expect(burrow.invitationState(invitation.inviteId)).toBe('consumed');
    expect(dismissed).toEqual(['c1']);
  });

  it('gives the confirmation exactly one attempt', async () => {
    makeBurrow();
    const authenticator = await newAuthenticator();
    const { invitation, session, code } = await requestPairing('c1', authenticator);

    approvals[0]!.approve(code === '00' ? '01' : '00');
    expect(await outcome(session, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'confirmation-mismatch',
    });
    expect(savedRecords).toHaveLength(0);

    // The right code afterwards buys nothing: a two-digit secret with retries
    // is not a secret.
    const sentBefore = socket.sent.length;
    approvals[0]!.approve(code);
    await settle();
    expect(socket.sent.length).toBe(sentBefore);
    expect(savedRecords).toHaveLength(0);
  });

  it('denies locally without touching the ACL', async () => {
    makeBurrow();
    const authenticator = await newAuthenticator();
    const { invitation, session } = await requestPairing('c1', authenticator);
    approvals[0]!.deny();
    expect(await outcome(session, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'user-denied',
    });
    expect(savedRecords).toHaveLength(0);
    expect(burrow.invitationState(invitation.inviteId)).toBe('consumed');
  });

  it('expires a pairing on the pairing TTL, even mid-deliberation', async () => {
    makeBurrow();
    const authenticator = await newAuthenticator();
    const { invitation, session, code } = await requestPairing('c1', authenticator);
    clock += DEFAULT_PAIRING_TTL_MS + 1;
    approvals[0]!.approve(code);
    expect(await outcome(session, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'invitation-expired',
    });
    expect(savedRecords).toHaveLength(0);
  });

  it('supersedes a pending pairing when the same client starts another', async () => {
    makeBurrow();
    const authenticator = await newAuthenticator();
    const first = await requestPairing('c1', authenticator);
    await requestPairing('c1', authenticator);
    expect(await outcome(first.session, 'pairing', first.invitation.inviteId)).toEqual({
      ok: false,
      code: 'superseded',
    });
    // Its invitation goes with it: the replaced ceremony can never resume.
    expect(burrow.invitationState(first.invitation.inviteId)).toBe('consumed');
  });

  /** The last thing said about one invitation, which is the change that retired it. */
  function retirement(invitation: PairingInvitation) {
    return invitationEvents.filter((event) => event.inviteId === invitation.inviteId).at(-1);
  }

  it('reports how each pairing ended, not only that it did', async () => {
    // Every terminal outcome spends the code and dismisses the modal, so
    // `consumed` on its own reads the same whether the pairing succeeded or the
    // digits were mistyped — and the paired count, the only other signal, is
    // absolute, so on a machine that already has a phone it does not move
    // either (`docs/specs/relay.md` → "Remote control, in the Settings dialog").
    makeBurrow();
    const authenticator = await newAuthenticator();
    const ended = async (clientId: string) => {
      const pairing = await requestPairing(clientId, authenticator);
      return { ...pairing, pending: approvals.at(-1)! };
    };

    const approved = await ended('c1');
    approved.pending.approve(approved.code);
    await settle();
    expect(retirement(approved.invitation)?.outcome).toBe('paired');

    const mistyped = await ended('c2');
    mistyped.pending.approve(mistyped.code === '00' ? '01' : '00');
    await settle();
    expect(retirement(mistyped.invitation)?.outcome).toBe('code-mismatch');

    const cancelled = await ended('c3');
    cancelled.pending.deny();
    await settle();
    expect(retirement(cancelled.invitation)?.outcome).toBe('cancelled');

    // A replacement from the same phone, which the modal has already been
    // showing the first request for.
    const replaced = await ended('c4');
    await requestPairing('c4', authenticator);
    expect(retirement(replaced.invitation)?.outcome).toBe('superseded');

    // A first control this Burrow cannot parse never reaches a modal, so all it
    // can report locally is that the ceremony ended and paired nothing.
    const malformed = await requestPairing('c5', authenticator, { code: 'not-two-digits' });
    expect(retirement(malformed.invitation)?.outcome).toBe('burrow-error');

    // Last, because it moves the clock past every other invitation's TTL.
    const timedOut = await ended('c6');
    clock += DEFAULT_PAIRING_TTL_MS + 1;
    timedOut.pending.approve(timedOut.code);
    await settle();
    expect(retirement(timedOut.invitation)?.outcome).toBe('expired');

    // Every one of them spent its code, and only the first paired anything.
    expect(invitationEvents.filter((event) => event.outcome !== undefined)).toHaveLength(6);
    for (const event of invitationEvents.filter((e) => e.outcome)) {
      expect(event.state).toBe('consumed');
    }
    expect(savedRecords).toHaveLength(1);
  });

  it('reports no outcome for a ceremony nobody decided', async () => {
    // A lost relay socket ends the ceremony without anyone answering it, so
    // there is no decision to report — and the panel behind the modal is about
    // to say the machine is reconnecting, which is the fact that matters.
    makeBurrow();
    const { invitation } = await requestPairing('c1', await newAuthenticator());
    invitationEvents.length = 0;
    socket.drop();
    await settle();

    expect(retirement(invitation)).toEqual({ inviteId: invitation.inviteId, state: 'consumed' });
  });

  it('refuses a proof bound to another handshake', async () => {
    makeBurrow();
    const authenticator = await newAuthenticator();
    const invitation = await mintInvitation();
    const session = await openPairing('c1', invitation, await generateNoiseKeyPair());
    const binding: PresenceBinding = {
      kind: 'pairing',
      burrowId: enrollment.burrowId,
      // Not this transcript's hash: exactly what a proof lifted from another
      // ceremony, or minted by a Relay that never saw one, looks like.
      handshakeHash: randomBase64Url(32),
      passkeyCredentialId: authenticator.credentialId,
    };
    sendE2e(
      'c1',
      'pairing',
      invitation.inviteId,
      'transport',
      toBase64Url(
        session!.sendControl({
          code: '42',
          label: 'iPhone Safari',
          presence: await presenceProofFor(authenticator, binding),
        }),
      ),
    );
    await settle();
    expect(approvals).toHaveLength(0);
    expect(await outcome(session!, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'presence-rejected',
    });
    expect(burrow.invitationState(invitation.inviteId)).toBe('consumed');
  });

  it('treats an unparseable first control as a hard failure', async () => {
    makeBurrow();
    const invitation = await mintInvitation();
    const session = await openPairing('c1', invitation, await generateNoiseKeyPair());
    sendE2e(
      'c1',
      'pairing',
      invitation.inviteId,
      'transport',
      toBase64Url(session!.sendControl({ code: 'not-two-digits' })),
    );
    await settle();
    expect(await outcome(session!, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'burrow-error',
    });
    expect(burrow.invitationState(invitation.inviteId)).toBe('consumed');
  });

  it('accepts one handshake per invitation and drops the second undecrypted', async () => {
    makeBurrow();
    const invitation = await mintInvitation();
    expect(await openPairing('c1', invitation, await generateNoiseKeyPair())).not.toBeNull();
    // A second scanner of the same photographed code gets nothing at all: an id
    // that is not `live` is refused before any handshake runs.
    expect(await openPairing('c2', invitation, await generateNoiseKeyPair())).toBeNull();
    expect(burrow.trackedClientCount).toBe(1);
  });

  it('leaves an invitation live when its handshake fails, and allocates nothing', async () => {
    makeBurrow();
    const invitation = await mintInvitation();
    sendE2e('hostile', 'pairing', invitation.inviteId, 'init', toBase64Url(new Uint8Array(96)));
    await settle();
    expect(burrow.invitationState(invitation.inviteId)).toBe('live');
    // No entry under a relay-chosen key for a peer that proved nothing.
    expect(burrow.trackedClientCount).toBe(0);
    expect(await openPairing('c1', invitation, await generateNoiseKeyPair())).not.toBeNull();
  });

  it('caps outstanding invitations at the Relay’s own bound, oldest first', async () => {
    makeBurrow();
    const first = await mintInvitation();
    for (let i = 1; i < MAX_TOKENS_PER_BURROW; i += 1) await mintInvitation();
    expect(burrow.outstandingInvitationCount).toBe(MAX_TOKENS_PER_BURROW);
    await mintInvitation();
    expect(burrow.outstandingInvitationCount).toBe(MAX_TOKENS_PER_BURROW);
    expect(burrow.invitationState(first.inviteId)).toBe('consumed');
    // Evicted un-scanned, so the panel showing it is told to get a new code
    // rather than to finish on a phone that never asked.
    expect(invitationEvents).toContainEqual({ inviteId: first.inviteId, state: 'dropped' });
  });

  it('holds the cap when two mints overlap across the keygen', async () => {
    // The one await in `mintInvitation` is `generateNoiseKeyPair`. Evicting
    // before it lets two mints read the same pre-await size, each evict one,
    // and then both insert — one past the cap the Relay's setup-token bound is
    // shared with.
    makeBurrow();
    for (let i = 0; i < MAX_TOKENS_PER_BURROW; i += 1) await mintInvitation();
    expect(burrow.outstandingInvitationCount).toBe(MAX_TOKENS_PER_BURROW);

    await Promise.all([mintInvitation(), mintInvitation(), mintInvitation()]);

    expect(burrow.outstandingInvitationCount).toBe(MAX_TOKENS_PER_BURROW);
  });

  it('refuses to mint onto a Burrow torn down while the keygen was in flight', async () => {
    // A QR the panel paints `live` over a relay socket that is gone, plus a
    // re-armed reaper on a Burrow that holds nothing — both from the same window.
    // Both teardowns, because invitations go with the *socket*: a close retires
    // them without stopping the Burrow, so a guard that only knew about `stop()`
    // would leave the far more common trigger open.
    for (const teardown of [() => burrow.stop(), () => socket.closeWith(1006)]) {
      makeBurrow();
      const minting = burrow.mintInvitation(randomBase64Url(32), clock + DEFAULT_PAIRING_TTL_MS);
      teardown();

      await expect(minting).rejects.toThrow(/could not mint a setup code/);
      expect(burrow.outstandingInvitationCount).toBe(0);
    }
  });

  it('reports an invitation expired once its TTL passes', async () => {
    makeBurrow();
    const invitation = await mintInvitation();
    clock += DEFAULT_PAIRING_TTL_MS + 1;
    expect(burrow.invitationState(invitation.inviteId)).toBe('expired');
    // And the entry is reaped — with its key — on the next frame that arrives.
    sendE2e('c1', 'pairing', invitation.inviteId, 'init', toBase64Url(new Uint8Array(96)));
    await settle();
    expect(burrow.invitationState(invitation.inviteId)).toBe('consumed');
    expect(invitationEvents).toContainEqual({ inviteId: invitation.inviteId, state: 'expired' });
  });

  // --- Connection ----------------------------------------------------------

  /** Pair a client, then hand back what a connection needs. */
  async function pairedClient(clientId = 'c1') {
    const authenticator = await newAuthenticator();
    const { invitation, clientStatic, session, code } = await requestPairing(clientId, authenticator);
    approvals[approvals.length - 1]!.approve(code);
    const answer = await outcome(session, 'pairing', invitation.inviteId);
    return { authenticator, clientStatic, record: savedRecords[0]!, deliveryId: answer.deliveryId };
  }

  /** Run the connection IK handshake; returns the session and the Burrow challenge. */
  function openConnection(clientId: string, clientStatic: NoiseKeyPair, connectionId: string) {
    return openConnectionSession({
      socket,
      burrowId: enrollment.burrowId,
      clientId,
      connectionId,
      clientStatic,
      burrowStaticPublicKey: enrollment.noiseStaticPublicKey!,
    });
  }

  function connectionBinding(
    connectionId: string,
    burrowChallenge: string,
    session: NoiseTransportSession,
    passkeyCredentialId: string,
  ): PresenceBinding {
    return {
      kind: 'connection',
      burrowId: enrollment.burrowId,
      connectionId,
      burrowChallenge,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId,
    };
  }

  it('connects: IK against the pinned static, presence, then protocol-v1 inside', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
    const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
    sendE2e(
      'c1',
      'connection',
      connectionId,
      'transport',
      toBase64Url(session.sendControl({ presence: await presenceProofFor(authenticator, binding) })),
    );
    await settle();
    expect(await outcome(session, 'connection', connectionId)).toEqual({
      ok: true,
      burrowLabel: BURROW_LABEL,
    });

    // Promotion hands the session's byte stream to protocol-v1, both ways.
    for (const ciphertext of session.sendApp(
      utf8Encode(JSON.stringify({ requestId: 'r1', method: 'hello' })),
    )) {
      sendE2e('c1', 'connection', connectionId, 'transport', toBase64Url(ciphertext));
    }
    await settle();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.handled).toEqual([{ requestId: 'r1', method: 'hello' }]);

    sessions[0]!.send({ requestId: 'r1', ok: true });
    const back = await flushUntil(() => {
      const frames = e2eFrames('connection', connectionId).filter((f) => f.step === 'transport');
      return frames[frames.length - 1];
    });
    const receipt = session.receive(fromBase64Url(back.ct as string));
    expect(receipt.kind).toBe('app');
    if (receipt.kind !== 'app') throw new Error('unreachable');
    expect(JSON.parse(utf8Decode(receipt.messages[0]!))).toEqual({ requestId: 'r1', ok: true });
  });

  /** Ask for a connection and return the decrypted outcome. */
  async function attemptConnection(
    clientId: string,
    clientStatic: NoiseKeyPair,
    authenticator: TestAuthenticator,
    tamper: {
      binding?: (binding: PresenceBinding) => PresenceBinding;
      accountId?: string;
      control?: Record<string, unknown>;
      presence?: PresenceProofV1;
    } = {},
  ): Promise<Record<string, unknown>> {
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection(clientId, clientStatic, connectionId);
    const honest = connectionBinding(
      connectionId,
      burrowChallenge,
      session,
      authenticator.credentialId,
    );
    const binding = tamper.binding ? tamper.binding(honest) : honest;
    const control =
      tamper.control ??
      ({
        presence:
          tamper.presence ??
          (await presenceProofFor(authenticator, binding, { accountId: tamper.accountId })),
      } as Record<string, unknown>);
    sendE2e(
      clientId,
      'connection',
      connectionId,
      'transport',
      toBase64Url(session.sendControl(control)),
    );
    await settle();
    return await outcome(session, 'connection', connectionId);
  }

  it('answers pairing-required for every ACL miss, and says no more than that', async () => {
    const { authenticator, clientStatic } = await (async () => {
      makeBurrow();
      return await pairedClient();
    })();
    const paired = savedRecords[0]!;

    // A Client static nobody approved.
    expect(
      await attemptConnection('c2', await generateNoiseKeyPair(), authenticator),
    ).toEqual({ ok: false, code: 'pairing-required' });

    // A passkey nobody approved, from the approved browser.
    const strangerPasskey = await newAuthenticator();
    expect(await attemptConnection('c1', clientStatic, strangerPasskey)).toEqual({
      ok: false,
      code: 'pairing-required',
    });

    // Halves that are each paired, but never together: the conjunction is the
    // record, not the two identities.
    const other = await newAuthenticator();
    const otherStatic = await generateNoiseKeyPair();
    const invitation = await mintInvitation();
    const session = await openPairing('c3', invitation, otherStatic);
    const pairBinding: PresenceBinding = {
      kind: 'pairing',
      burrowId: enrollment.burrowId,
      handshakeHash: toBase64Url(session!.handshakeHash),
      passkeyCredentialId: other.credentialId,
    };
    sendE2e(
      'c3',
      'pairing',
      invitation.inviteId,
      'transport',
      toBase64Url(
        session!.sendControl({
          code: '11',
          label: 'iPad',
          presence: await presenceProofFor(other, pairBinding),
        }),
      ),
    );
    await settle();
    approvals[approvals.length - 1]!.approve('11');
    expect(savedRecords).toHaveLength(2);
    expect(await attemptConnection('c1', clientStatic, other)).toEqual({
      ok: false,
      code: 'pairing-required',
    });
    // The mismatch changed nothing about the record that does authorize.
    expect(savedRecords[0]).toEqual(paired);
  });

  it('refuses a proof that names the wrong ceremony values', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const denial = { ok: false, code: 'presence-rejected' };

    // Each of the three values the connection binding pins, one at a time.
    expect(
      await attemptConnection('c1', clientStatic, authenticator, {
        binding: (b) => ({ ...b, handshakeHash: randomBase64Url(32) }),
      }),
    ).toEqual(denial);
    expect(
      await attemptConnection('c1', clientStatic, authenticator, {
        binding: (b) => ({ ...b, burrowChallenge: randomBase64Url(32) }),
      }),
    ).toEqual(denial);
    expect(
      await attemptConnection('c1', clientStatic, authenticator, {
        binding: (b) => ({ ...b, connectionId: testRoutingId() }),
      }),
    ).toEqual(denial);
  });

  it('refuses a proof whose assertion was signed over a different binding', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
    const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
    // The Relay substituting a challenge it minted for another ceremony: the
    // binding is this connection's, the signature is not.
    const presence = await presenceProofFor(authenticator, binding, {
      assertionBinding: { ...binding, connectionId: testRoutingId() },
    });
    sendE2e(
      'c1',
      'connection',
      connectionId,
      'transport',
      toBase64Url(session.sendControl({ presence })),
    );
    await settle();
    expect(await outcome(session, 'connection', connectionId)).toEqual({
      ok: false,
      code: 'presence-rejected',
    });
  });

  it('refuses a replayed proof, because the Burrow challenge is single-use', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
    const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
    const presence = await presenceProofFor(authenticator, binding);
    sendE2e('c1', 'connection', connectionId, 'transport', toBase64Url(session.sendControl({ presence })));
    await settle();
    expect(await outcome(session, 'connection', connectionId)).toEqual({ ok: true, burrowLabel: BURROW_LABEL });

    // The same proof against a fresh handshake: the challenge it names was
    // burned by the attempt above, so nothing about it is fresh any more.
    expect(await attemptConnection('c2', clientStatic, authenticator, { presence })).toEqual({
      ok: false,
      code: 'presence-rejected',
    });
  });

  it('refuses an expired Burrow challenge', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
    clock += DEFAULT_CHALLENGE_TTL_MS + 1;
    const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
    sendE2e(
      'c1',
      'connection',
      connectionId,
      'transport',
      toBase64Url(session.sendControl({ presence: await presenceProofFor(authenticator, binding) })),
    );
    await settle();
    expect(await outcome(session, 'connection', connectionId)).toEqual({
      ok: false,
      code: 'presence-rejected',
    });
  });

  it('refuses an ACL record approved for another account', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    expect(
      await attemptConnection('c1', clientStatic, authenticator, { accountId: 'someone-else' }),
    ).toEqual({ ok: false, code: 'pairing-required' });
  });

  it('answers protocol-rejected for a control message it cannot read', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    expect(
      await attemptConnection('c1', clientStatic, authenticator, { control: { hello: 'there' } }),
    ).toEqual({ ok: false, code: 'protocol-rejected' });
  });

  it('destroys a session on the first invalid ciphertext', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
    const framesBefore = e2eFrames('connection', connectionId).length;
    sendE2e('c1', 'connection', connectionId, 'transport', toBase64Url(new Uint8Array(64)));
    await settle();
    // No outcome — there is nothing to say on a poisoned session — and the
    // pending state is gone, so an honest frame after it reaches nothing.
    expect(e2eFrames('connection', connectionId).length).toBe(framesBefore);
    const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
    sendE2e(
      'c1',
      'connection',
      connectionId,
      'transport',
      toBase64Url(session.sendControl({ presence: await presenceProofFor(authenticator, binding) })),
    );
    await settle();
    expect(e2eFrames('connection', connectionId).length).toBe(framesBefore);
    expect(burrow.trackedClientCount).toBe(0);
  });

  it('accepts keepalives on an established session and ignores them', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
    const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
    sendE2e(
      'c1',
      'connection',
      connectionId,
      'transport',
      toBase64Url(session.sendControl({ presence: await presenceProofFor(authenticator, binding) })),
    );
    await settle();
    await outcome(session, 'connection', connectionId);
    const framesBefore = socket.sent.length;
    sendE2e('c1', 'connection', connectionId, 'transport', toBase64Url(session.sendKeepalive()));
    await settle();
    expect(socket.sent.length).toBe(framesBefore);
    expect(sessions[0]!.handled).toEqual([]);
    expect(sessions[0]!.disposed).toBe(false);
  });

  // --- Lifecycle -----------------------------------------------------------

  it('disposes a client’s ceremonies and session on client-gone', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
    const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
    sendE2e(
      'c1',
      'connection',
      connectionId,
      'transport',
      toBase64Url(session.sendControl({ presence: await presenceProofFor(authenticator, binding) })),
    );
    await settle();
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    await settle();
    expect(sessions[0]!.disposed).toBe(true);
    expect(burrow.trackedClientCount).toBe(0);
  });

  it('drops every ceremony and invitation when the relay socket closes', async () => {
    makeBurrow();
    await requestPairing('c1', await newAuthenticator());
    const spare = await mintInvitation();
    socket.drop();
    await settle();
    expect(burrow.trackedClientCount).toBe(0);
    expect(burrow.outstandingInvitationCount).toBe(0);
    // The code on a second window's screen dies with the socket it was minted
    // over: its one-use key lived only in the Burrow that just lost the relay.
    expect(burrow.invitationState(spare.inviteId)).toBe('consumed');
    expect(dismissed).toContain('c1');
    // But nobody scanned it, so the panel must not be told it was: `dropped`
    // and `consumed` are different facts, and only the reserved one is spent.
    expect(invitationEvents).toContainEqual({ inviteId: spare.inviteId, state: 'dropped' });
    expect(invitationEvents.filter((e) => e.state === 'dropped')).toHaveLength(1);
  });

  it('ignores late opens from a stopped or superseded socket', () => {
    makeBurrow();
    const retiredSocket = socket;
    burrow.stop();
    retiredSocket.open();
    expect(burrow.status).toBe('stopped');

    burrow.start();
    retiredSocket.open();
    expect(burrow.status).toBe('connecting');
    socket.open();
    expect(burrow.status).toBe('connected');
  });

  it('ignores a retired socket client-gone after restarting', async () => {
    makeBurrow();
    const { authenticator, clientStatic } = await pairedClient();
    const retiredSocket = socket;
    burrow.stop();
    burrow.start();
    socket.open();
    expect(await attemptConnection('c1', clientStatic, authenticator)).toMatchObject({ ok: true });
    expect(sessions).toHaveLength(1);

    retiredSocket.receive({ t: 'client-gone', clientId: 'c1' });
    await settle();
    expect(sessions[0]!.disposed).toBe(false);
    expect(burrow.trackedClientCount).toBe(1);

    socket.receive({ t: 'client-gone', clientId: 'c1' });
    await settleUntil(() => sessions[0]!.disposed);
    expect(burrow.trackedClientCount).toBe(0);
  });

  it('client-gone during a handshake disposes what the handshake then creates', async () => {
    // `client-gone` is queued on the same chain as every `e2e` step. Run inline
    // it would land *between* the responder's awaits, find nothing to dispose,
    // and leave the resumed init holding a reserved invitation and a client
    // entry for a peer the relay has already forgotten — one nothing removes.
    makeBurrow();
    const invitation = await mintInvitation();
    await sendPairingInit('c1', invitation);
    // No await between the two: the init's WebCrypto is still in flight.
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    // Named, not counted: the step this waits on is a dozen WebCrypto awaits,
    // which no fixed number of turns can be trusted to cover.
    await settleUntil(() => burrow.invitationState(invitation.inviteId) === 'consumed');

    expect(burrow.trackedClientCount).toBe(0);
    expect(approvals).toEqual([]);
    // The invitation is spent either way — a phone did complete message 1
    // against it — but it must not be left `reserved` on a client that is gone.
    expect(burrow.invitationState(invitation.inviteId)).toBe('consumed');
    expect(burrow.outstandingInvitationCount).toBe(0);
  });

  it('a mint that retires the invitation mid-handshake allocates nothing', async () => {
    // `mintInvitation` is the panel's, not the relay's: it runs off the frame
    // chain and reaps synchronously, so it can retire the very entry a
    // suspended `#onPairingInit` is holding. Resuming onto that detached object
    // would announce `reserved` for an id already reported gone, and leave a
    // client entry naming an invitation no dispose can retire.
    makeBurrow();
    const invitation = await mintInvitation();
    await sendPairingInit('c1', invitation);
    // No await between the two: the init's WebCrypto is still in flight when
    // the clock moves past the TTL and the next mint reaps it.
    clock += DEFAULT_PAIRING_TTL_MS + 1;
    await mintInvitation();
    await settleUntil(() =>
      invitationEvents.some((e) => e.inviteId === invitation.inviteId && e.state === 'expired'),
    );

    expect(invitationEvents).toContainEqual({
      inviteId: invitation.inviteId,
      state: 'expired',
    });
    // Nothing after the terminal event: the resumed handshake stood down.
    expect(invitationEvents.filter((e) => e.inviteId === invitation.inviteId)).toHaveLength(1);
    expect(burrow.trackedClientCount).toBe(0);
    expect(approvals).toEqual([]);
  });

  /** Send pairing message 1 without awaiting the Burrow's answer. */
  async function sendPairingInit(clientId: string, invitation: PairingInvitation): Promise<void> {
    const handshake = await createNoiseInitiator({
      prologue: pairingInvitationPrologue(invitation),
      staticKeyPair: await generateNoiseKeyPair(),
      remoteStaticPublicKey: invitation.ephPub,
    });
    sendE2e(clientId, 'pairing', invitation.inviteId, 'init', toBase64Url(await handshake.writeMessage()));
  }

  // Teardown is not a frame: `stop()` and the socket's own `close` run it
  // synchronously, so it lands mid-await where the chain cannot order it. A
  // handshake finishing afterwards must not re-reserve the invitation it just
  // retired, and must not allocate an entry no later close will ever clear.
  it.each([
    ['stop()', () => burrow.stop()],
    ['a dropped socket', () => socket.drop()],
  ])('a handshake finishing after %s allocates nothing', async (_name, teardown) => {
    makeBurrow();
    const invitation = await mintInvitation();
    await sendPairingInit('c1', invitation);
    teardown();
    await settle();

    expect(burrow.trackedClientCount).toBe(0);
    expect(burrow.outstandingInvitationCount).toBe(0);
    expect(invitationEvents.at(-1)).not.toMatchObject({ state: 'reserved' });
    expect(burrow.invitationState(invitation.inviteId)).toBe('consumed');
  });

  it('a connection handshake finishing after stop() allocates nothing', async () => {
    makeBurrow();
    const { clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const handshake = await createNoiseInitiator({
      prologue: e2eConnectionPrologue(enrollment.burrowId, connectionId),
      staticKeyPair: clientStatic,
      remoteStaticPublicKey: fromBase64Url(enrollment.noiseStaticPublicKey!),
    });
    sendE2e('c2', 'connection', connectionId, 'init', toBase64Url(await handshake.writeMessage()));
    burrow.stop();
    await settle();

    expect(burrow.trackedClientCount).toBe(0);
  });

  it('ignores a connection init delivered after stop()', async () => {
    makeBurrow();
    const { clientStatic } = await pairedClient();
    const connectionId = testRoutingId();
    const handshake = await createNoiseInitiator({
      prologue: e2eConnectionPrologue(enrollment.burrowId, connectionId),
      staticKeyPair: clientStatic,
      remoteStaticPublicKey: fromBase64Url(enrollment.noiseStaticPublicKey!),
    });
    const init = toBase64Url(await handshake.writeMessage());
    burrow.stop();
    sendE2e('c2', 'connection', connectionId, 'init', init);
    await settle();

    expect(burrow.trackedClientCount).toBe(0);
    expect(burrow.status).toBe('stopped');
  });

  it('expiring a scanned invitation reports consumed, and says the request timed out', async () => {
    // The pairing shares the invitation's `expiresAt`, so one sweep covers
    // both: the code is `consumed` because a phone did scan it — anything else
    // would flip the panel to "nobody scanned it" about the code in their hand
    // — and the pairing's own deadline is the only thing that knows why. It
    // therefore runs first, and its outcome is what a person still deciding at
    // the modal is left holding.
    makeBurrow();
    const { invitation } = await requestPairing('c1', await newAuthenticator());
    invitationEvents.length = 0;
    clock += DEFAULT_PAIRING_TTL_MS + 1;
    // Any `init` runs the reaper; this one is refused by the id it names.
    sendE2e('c2', 'pairing', invitation.inviteId, 'init', toBase64Url(new Uint8Array(96)));
    await settle();

    expect(invitationEvents).toEqual([
      { inviteId: invitation.inviteId, state: 'consumed', outcome: 'expired' },
    ]);
  });

  it('evicting a scanned invitation at the cap reports consumed, not dropped', async () => {
    // `dropped` means nobody scanned it. The oldest by insertion is whatever it
    // is doing, so an eviction that always said `dropped` would tell the panel
    // to offer a new code for a ceremony a phone is mid-way through.
    makeBurrow();
    const scanned = await requestPairing('c1', await newAuthenticator());
    invitationEvents.length = 0;
    for (let i = 0; i < MAX_TOKENS_PER_BURROW; i += 1) await mintInvitation();

    expect(invitationEvents).toContainEqual({
      inviteId: scanned.invitation.inviteId,
      state: 'consumed',
    });
    expect(
      invitationEvents.filter((e) => e.inviteId === scanned.invitation.inviteId),
    ).toHaveLength(1);
  });

  it('stands down for good on a displacement close', async () => {
    makeBurrow();
    socket.closeWith(WS_CLOSE_BURROW_REPLACED);
    await settle();
    expect(burrow.status).toBe('displaced');
  });

  it('ignores every frame that is not the e2e envelope or client-gone', async () => {
    makeBurrow();
    for (const t of ['pair', 'pair-status', 'connect', 'connect2', 'msg']) {
      socket.receive({ t, clientId: 'c1', request: {}, query: {}, data: {} });
    }
    await settle();
    expect(socket.sent).toEqual([]);
    expect(burrow.trackedClientCount).toBe(0);
  });

  it('ignores a client-gone whose clientId is past the wire bound', async () => {
    makeBurrow();
    await requestPairing('c1', await newAuthenticator());
    expect(burrow.trackedClientCount).toBe(1);
    // The relay chooses this value and this is the one frame that reaches the
    // client map without the `e2e` guard, so the Burrow bounds it itself.
    socket.receive({ t: 'client-gone', clientId: 'x'.repeat(257) });
    socket.receive({ t: 'client-gone', clientId: 42 });
    await settle();
    expect(burrow.trackedClientCount).toBe(1);
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    await settle();
    expect(burrow.trackedClientCount).toBe(0);
  });

  it('allocates no challenge for a connection init that never authenticates', async () => {
    makeBurrow();
    const { clientStatic } = await pairedClient();
    expect(burrow.pendingChallengeCount).toBe(0);
    // Nothing but its own TTL reclaims a challenge, so a garbage `init` must
    // not leave one behind: the relay can send those at line rate.
    for (let i = 0; i < 5; i += 1) {
      sendE2e('c2', 'connection', testRoutingId(), 'init', toBase64Url(new Uint8Array(96)));
    }
    await settle();
    expect(burrow.pendingChallengeCount).toBe(0);
    // A real message 1 does allocate one — otherwise the assertion above would
    // pass against a Burrow that never issues at all.
    await openConnection('c1', clientStatic, testRoutingId());
    expect(burrow.pendingChallengeCount).toBe(1);
  });

  it('leaves no established session behind when there is no remote-api to build', async () => {
    // A Burrow with no session factory answers the outcome and holds nothing.
    // Leaving the previous `established` in place would route the next frame on
    // the old id into a handler that has already been disposed.
    makeBurrow(() => [], { withSession: false });
    const { authenticator, clientStatic } = await pairedClient();
    for (const connectionId of [testRoutingId(), testRoutingId()]) {
      const { session, burrowChallenge } = await openConnection('c1', clientStatic, connectionId);
      const binding = connectionBinding(connectionId, burrowChallenge, session, authenticator.credentialId);
      sendE2e(
        'c1',
        'connection',
        connectionId,
        'transport',
        toBase64Url(session.sendControl({ presence: await presenceProofFor(authenticator, binding) })),
      );
      expect(await outcome(session, 'connection', connectionId)).toEqual({
        ok: true,
        burrowLabel: BURROW_LABEL,
      });
    }
    await settle();
    expect(burrow.trackedClientCount).toBe(0);
  });

  it('refuses to pair when this Burrow has no Noise static to present', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const created = new BurrowRuntime({
      // Every other field is a real enrollment; only the static is missing,
      // which is the state a corrupt store leaves behind.
      enrollment: {
        ...enrollment,
        noiseStaticPrivateKey: undefined,
        noiseStaticPublicKey: undefined,
      },
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [],
      saveAcl: (_burrowId, records) => {
        savedRecords = [...records];
      },
      requestApproval: (pending) => approvals.push(pending),
      dismissApproval: (clientId) => dismissed.push(clientId),
      onInvitationChanged: recordInvitation,
      now: () => clock,
    });
    created.start();
    socket.open();
    burrow = created;
    burrows.push(created);

    const { invitation, session, code } = await requestPairing('c1', await newAuthenticator());
    approvals[0]!.approve(code);
    // A record written here would authorize a Client that could never complete
    // a connection IK, and its `burrowStaticPublicKey` pin would be empty.
    expect(await outcome(session, 'pairing', invitation.inviteId)).toEqual({
      ok: false,
      code: 'burrow-error',
    });
    expect(savedRecords).toEqual([]);
    warn.mockRestore();
  });

  it('drops a frame whose routing values are out of shape, before any crypto', async () => {
    makeBurrow();
    const generateKey = vi.spyOn(globalThis.crypto.subtle, 'generateKey');
    const invitation = await mintInvitation();
    generateKey.mockClear();
    for (const frame of [
      { t: 'e2e', clientId: 'c1', burrowId: 'short', kind: 'pairing', id: invitation.inviteId, step: 'init', ct: 'AAAA' },
      { t: 'e2e', clientId: 'c1', burrowId: enrollment.burrowId, kind: 'nope', id: invitation.inviteId, step: 'init', ct: 'AAAA' },
      { t: 'e2e', clientId: 'c1', burrowId: enrollment.burrowId, kind: 'pairing', id: 'short', step: 'init', ct: 'AAAA' },
      { t: 'e2e', clientId: 'c1', burrowId: enrollment.burrowId, kind: 'pairing', id: invitation.inviteId, step: 'init', ct: 'not base64url!' },
      { t: 'e2e', clientId: 42, burrowId: enrollment.burrowId, kind: 'pairing', id: invitation.inviteId, step: 'init', ct: 'AAAA' },
    ]) {
      socket.receive(frame);
    }
    await settle();
    expect(generateKey).not.toHaveBeenCalled();
    expect(burrow.trackedClientCount).toBe(0);
    expect(burrow.invitationState(invitation.inviteId)).toBe('live');
    generateKey.mockRestore();
  });
});

/**
 * The Client half of the two end-to-end ceremonies, as a test drives it.
 *
 * Test-only, and shared on purpose — the same reasoning as
 * `lib/src/remote/test-fake-socket.ts`. Both suites that exercise a real Host
 * (`remote/host/remote-host.test.ts`, `host/remote/service.test.ts`) need the
 * same three things: a faithful WebAuthn authenticator, a presence proof built
 * over the shared challenge builder, and a real Noise IK initiator speaking the
 * `e2e` envelope. Two copies would be two opinions about what a valid ceremony
 * is, and the Host would be tested against whichever one was written last.
 *
 * Nothing here is stubbed: the assertion is a real ES256 signature and the
 * handshake is the shipped suite, so a case that passes here would pass against
 * a real phone.
 */

import {
  NoiseTransportSession,
  concatBytes,
  createNoiseInitiator,
  e2eConnectionPrologue,
  ecdsaRawToDer,
  fromBase64Url,
  generateNoiseKeyPair,
  pairingInvitationPrologue,
  presenceChallenge,
  randomBase64Url,
  toBase64Url,
  utf8Encode,
  type NoiseKeyPair,
  type PairingInvitation,
  type PasskeyAssertion,
  type PresenceBinding,
  type PresenceProofV1,
} from 'server-lib-common';
import type { FakeSocket } from './test-fake-socket';

const subtle = globalThis.crypto.subtle;

export { randomBase64Url };

/** A routing id as the relay mints one: base64url of 16 bytes. */
export function testRoutingId(): string {
  return randomBase64Url(16);
}

/**
 * A detached copy of `bytes` as an `ArrayBuffer`. WebCrypto's DOM typings want
 * one whose backing buffer cannot be shared, which a `Uint8Array` view does not
 * promise; copying is also what keeps a caller's reused read buffer from
 * changing under an in-flight `sign`.
 */
function bufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.slice().buffer as ArrayBuffer;
}

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', bufferOf(bytes)));
}

export interface TestAuthenticator {
  /** Base64url SPKI, as `getPublicKey()` hands it over. */
  readonly publicKey: string;
  readonly credentialId: string;
  assert(challenge: string, origin?: string): Promise<PasskeyAssertion>;
}

/**
 * One passkey. WebAuthn is simulated faithfully enough to exercise the real
 * verifier: `clientDataJSON`, `authenticatorData` (rpIdHash / flags /
 * signCount), and a DER-encoded ES256 signature over
 * `authData || sha256(clientDataJSON)`.
 */
export async function createTestAuthenticator(options: {
  rpId: string;
  origin: string;
}): Promise<TestAuthenticator> {
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await subtle.exportKey('spki', keyPair.publicKey));
  const credentialId = randomBase64Url(16);
  let signCount = 0;

  return {
    publicKey: toBase64Url(spki),
    credentialId,
    async assert(challenge, origin = options.origin) {
      const clientDataJSON = utf8Encode(
        JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
      );
      const rpIdHash = await sha256(utf8Encode(options.rpId));
      signCount += 1;
      const flags = 0x01 | 0x04; // user present + user verified
      const authenticatorData = concatBytes(
        rpIdHash,
        Uint8Array.of(
          flags,
          (signCount >>> 24) & 0xff,
          (signCount >>> 16) & 0xff,
          (signCount >>> 8) & 0xff,
          signCount & 0xff,
        ),
      );
      const rawSignature = new Uint8Array(
        await subtle.sign(
          { name: 'ECDSA', hash: 'SHA-256' },
          keyPair.privateKey,
          bufferOf(concatBytes(authenticatorData, await sha256(clientDataJSON))),
        ),
      );
      return {
        credentialId,
        clientDataJSON: toBase64Url(clientDataJSON),
        authenticatorData: toBase64Url(authenticatorData),
        signature: toBase64Url(ecdsaRawToDer(rawSignature)),
      };
    },
  };
}

/**
 * The proof a Client puts in its first transport payload.
 *
 * The Server's nonce is unguessable to the Host, which recomputes the challenge
 * rather than trusting one, so a test supplies its own. `assertionBinding`
 * signs over a *different* binding than the one sent — which is how a
 * substituted or replayed proof is spelled.
 */
export async function presenceProofFor(
  authenticator: TestAuthenticator,
  binding: PresenceBinding,
  over: { accountId?: string; assertionBinding?: PresenceBinding; origin?: string } = {},
): Promise<PresenceProofV1> {
  const serverNonce = randomBase64Url(32);
  const challenge = await presenceChallenge(over.assertionBinding ?? binding, serverNonce);
  return {
    binding,
    serverNonce,
    accountId: over.accountId ?? 'owner',
    passkeyCredentialId: authenticator.credentialId,
    passkeyPublicKey: authenticator.publicKey,
    assertion: await authenticator.assert(challenge, over.origin),
  };
}

/** Poll until `get` answers, so a Host that awaits WebCrypto can catch up. */
export async function flushUntil<T>(get: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const value = await pollFor(get, timeoutMs);
  if (value === undefined) throw new Error('timed out waiting for a frame');
  return value;
}

/** Poll for at most `timeoutMs`, answering `undefined` if it never arrives. */
async function pollFor<T>(get: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) return undefined;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/**
 * Let everything already queued run, so a dropped frame stays dropped.
 *
 * **Several event-loop turns, not one.** A ceremony step is a dozen awaited
 * WebCrypto calls, and each resolves off the threadpool — under a full suite's
 * parallel load they do not all land inside a single timer, which made an
 * assertion about what the Host did *not* do pass vacuously and one about what
 * it did do fail. A caller with an observable should still name it through
 * {@link settleUntil}; this is the floor for the ones asserting absence.
 */
export async function settle(): Promise<void> {
  for (let round = 0; round < 8; round += 1) {
    for (let i = 0; i < 16; i += 1) await Promise.resolve();
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Wait for the Host to have *reacted* to a frame, then settle.
 *
 * A fixed settle is not enough: every ceremony step awaits several WebCrypto
 * calls, so on a loaded machine the reaction lands after any constant number of
 * turns. `until` names the observable the caller is actually waiting on — an
 * outcome frame, a queue event — and a caller with no such observable (a frame
 * that must be *dropped*) passes none and gets the plain settle.
 */
export async function settleUntil(until?: () => boolean): Promise<void> {
  if (until) await pollFor(() => (until() ? true : undefined), 2000);
  await settle();
}

/** The Host's outgoing `e2e` frames for one ceremony, in order. */
export function e2eFramesFor(
  socket: FakeSocket,
  kind: string,
  id: string,
): Array<Record<string, unknown>> {
  return socket.frames('e2e').filter((frame) => frame.kind === kind && frame.id === id);
}

/** Deliver one relay-stamped `e2e` frame to the Host. */
export function sendE2eFrame(
  socket: FakeSocket,
  frame: {
    clientId: string;
    hostId: string;
    kind: 'pairing' | 'connection';
    id: string;
    step: 'init' | 'transport';
    ct: string;
  },
): void {
  socket.receive({ t: 'e2e', ...frame });
}

/**
 * Decrypt the Host's most recent control message on one ceremony, waiting for
 * one to arrive.
 *
 * The wait is the point: every step of a ceremony awaits several WebCrypto
 * calls, so a test that read the frame log after a fixed number of turns would
 * pass on an idle machine and fail on a loaded one. A ceremony emits exactly
 * one outcome, so "at least one transport frame" is an unambiguous condition.
 */
export async function readOutcome(
  socket: FakeSocket,
  session: NoiseTransportSession,
  kind: string,
  id: string,
): Promise<Record<string, unknown>> {
  const last = await pollFor(() => {
    const frames = e2eFramesFor(socket, kind, id).filter((frame) => frame.step === 'transport');
    return frames[frames.length - 1];
  }, 2000);
  if (!last) throw new Error('the Host sent no outcome');
  const receipt = session.receive(fromBase64Url(last.ct as string));
  if (receipt.kind !== 'control') {
    throw new Error(`expected a control message, got ${receipt.kind}`);
  }
  return receipt.value;
}

/**
 * Run the pairing IK handshake against an invitation. Answers `null` when the
 * Host refused to respond at all, which is what an unknown, reserved, or
 * expired invitation looks like from here.
 */
export async function openPairingSession(options: {
  socket: FakeSocket;
  hostId: string;
  clientId: string;
  invitation: PairingInvitation;
  clientStatic: NoiseKeyPair;
}): Promise<NoiseTransportSession | null> {
  const { socket, hostId, clientId, invitation, clientStatic } = options;
  const handshake = await createNoiseInitiator({
    prologue: pairingInvitationPrologue(invitation),
    staticKeyPair: clientStatic,
    remoteStaticPublicKey: invitation.ephPub,
  });
  const before = e2eFramesFor(socket, 'pairing', invitation.inviteId).length;
  sendE2eFrame(socket, {
    clientId,
    hostId,
    kind: 'pairing',
    id: invitation.inviteId,
    step: 'init',
    ct: toBase64Url(await handshake.writeMessage()),
  });
  // Polled rather than settled: the Host's responder awaits several WebCrypto
  // calls, and a cold first run can outlast a couple of microtask turns. A
  // refusal is a real answer here, so the wait is short and its absence is the
  // result rather than a failure.
  const response = await pollFor(
    () => e2eFramesFor(socket, 'pairing', invitation.inviteId)[before],
    500,
  );
  if (!response) return null;
  await handshake.readMessage(fromBase64Url(response.ct as string));
  return new NoiseTransportSession(handshake.session);
}

/**
 * The whole Client side of a pairing up to the modal: handshake, presence
 * proof, and the two digits the Host will ask a person to type.
 */
export async function pairThroughSocket(options: {
  socket: FakeSocket;
  hostId: string;
  clientId: string;
  invitation: PairingInvitation;
  authenticator: TestAuthenticator;
  code?: string;
  label?: string;
  clientStatic?: NoiseKeyPair;
  /** What to wait for once the request is on the wire; see {@link settleUntil}. */
  until?: () => boolean;
}): Promise<{ session: NoiseTransportSession; clientStatic: NoiseKeyPair; code: string }> {
  const clientStatic = options.clientStatic ?? (await generateNoiseKeyPair());
  const session = await openPairingSession({ ...options, clientStatic });
  if (!session) throw new Error('the Host refused the pairing handshake');
  const code = options.code ?? '42';
  const presence = await presenceProofFor(options.authenticator, {
    kind: 'pairing',
    hostId: options.hostId,
    handshakeHash: toBase64Url(session.handshakeHash),
    passkeyCredentialId: options.authenticator.credentialId,
  });
  sendE2eFrame(options.socket, {
    clientId: options.clientId,
    hostId: options.hostId,
    kind: 'pairing',
    id: options.invitation.inviteId,
    step: 'transport',
    ct: toBase64Url(
      session.sendControl({ code, label: options.label ?? 'iPhone Safari', presence }),
    ),
  });
  await settleUntil(options.until);
  return { session, clientStatic, code };
}

/** Run the connection IK handshake against a pinned Host static. */
export async function openConnectionSession(options: {
  socket: FakeSocket;
  hostId: string;
  clientId: string;
  connectionId: string;
  clientStatic: NoiseKeyPair;
  hostStaticPublicKey: string;
}): Promise<{ session: NoiseTransportSession; hostChallenge: string }> {
  const handshake = await createNoiseInitiator({
    prologue: e2eConnectionPrologue(options.hostId, options.connectionId),
    staticKeyPair: options.clientStatic,
    remoteStaticPublicKey: fromBase64Url(options.hostStaticPublicKey),
  });
  sendE2eFrame(options.socket, {
    clientId: options.clientId,
    hostId: options.hostId,
    kind: 'connection',
    id: options.connectionId,
    step: 'init',
    ct: toBase64Url(await handshake.writeMessage()),
  });
  const response = await flushUntil(() =>
    e2eFramesFor(options.socket, 'connection', options.connectionId).find(
      (frame) => frame.step === 'response',
    ),
  );
  // Message 2's payload is the Host's fresh single-use challenge, which the
  // presence binding must name.
  const payload = await handshake.readMessage(fromBase64Url(response.ct as string));
  return {
    session: new NoiseTransportSession(handshake.session),
    hostChallenge: toBase64Url(payload),
  };
}

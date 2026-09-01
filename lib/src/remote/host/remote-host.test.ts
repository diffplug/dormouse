import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Holds one `authorizeConnection` call open per queued gate, in call order, so a
 * test can make an *older* evaluation finish last. Everything else about the
 * module is the real thing — the decision itself is never faked.
 */
const authProbe = vi.hoisted(() => ({ gates: [] as Array<Promise<void> | undefined>, calls: 0 }));
vi.mock('server-lib-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('server-lib-common')>();
  return {
    ...real,
    authorizeConnection: async (context: never, request: never) => {
      const gate = authProbe.gates[authProbe.calls++];
      const decision = await real.authorizeConnection(context, request);
      await gate;
      return decision;
    },
  };
});

import {
  DEFAULT_PAIRING_TTL_MS,
  WS_CLOSE_HOST_REPLACED,
  concatBytes,
  ecdsaRawToDer,
  generateDeviceKeyPair,
  hashPasskeyPublicKey,
  signDeviceChallenge,
  toBase64Url,
  utf8Encode,
  computeSetupProof,
  type ConnectionRequest,
  type HostAclRecord,
  type PairingRequest,
  MAX_PENDING_PAIRINGS,
  MAX_TOKENS_PER_HOST,
} from 'server-lib-common';
import { RemoteHost, type RemoteHostOptions } from './remote-host';
import type { HostEnrollment } from './enrollment';
import type { PendingPairing } from './pairing-approval';
import { FakeSocket } from '../test-fake-socket';

const ENROLLMENT: HostEnrollment = {
  serverUrl: 'https://host.example',
  hostId: 'host-1',
  hostToken: 'tok',
  origin: 'https://host.example',
  rpId: 'host.example',
};

// --- Minimal faithful WebAuthn authenticator (mirrors test/harness/actors.mjs) ---

const subtle = globalThis.crypto.subtle;

async function sha256(bytes: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

async function createAuthenticator(rpId: string) {
  const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ]);
  const spki = new Uint8Array(await subtle.exportKey('spki', keyPair.publicKey));
  const publicKey = toBase64Url(spki);
  const credentialId = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  let signCount = 0;

  async function assert(challenge: string, origin: string) {
    const clientDataJSON = utf8Encode(
      JSON.stringify({ type: 'webauthn.get', challenge, origin, crossOrigin: false }),
    );
    const rpIdHash = await sha256(utf8Encode(rpId));
    signCount += 1;
    const flags = 0x01 | 0x04; // user present + user verified
    const authenticatorData = concatBytes(
      rpIdHash,
      Uint8Array.of(flags, (signCount >>> 24) & 0xff, (signCount >>> 16) & 0xff, (signCount >>> 8) & 0xff, signCount & 0xff),
    );
    const rawSignature = new Uint8Array(
      await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        keyPair.privateKey,
        concatBytes(authenticatorData, await sha256(clientDataJSON)),
      ),
    );
    return {
      credentialId,
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(ecdsaRawToDer(rawSignature)),
    };
  }

  return { publicKey, credentialId, assert };
}

async function flushUntil<T>(get: () => T | undefined, timeoutMs = 2000): Promise<T> {
  const start = Date.now();
  for (;;) {
    const value = get();
    if (value !== undefined) return value;
    if (Date.now() - start > timeoutMs) throw new Error('timed out waiting for frame');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** Drive connect → connect2 and return the decision frame. */
async function runConnect(
  socket: FakeSocket,
  clientId: string,
  build: (challenge: string) => Promise<ConnectionRequest>,
): Promise<Record<string, unknown>> {
  socket.sent.length = 0;
  socket.receive({ t: 'connect', clientId });
  const challengeFrame = socket.frames('challenge')[0]!;
  const request = await build(challengeFrame.challenge as string);
  socket.receive({ t: 'connect2', clientId, request });
  return flushUntil(() => socket.frames('decision')[0]);
}

/** A promise a test releases by hand. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Let every already-queued microtask run. */
async function settle(): Promise<void> {
  for (let i = 0; i < 8; i += 1) await Promise.resolve();
}

describe('RemoteHost frame handling', () => {
  let socket: FakeSocket;
  let savedRecords: HostAclRecord[] = [];
  let approvals: PendingPairing[] = [];

  function makeHost(
    loadAcl: () => HostAclRecord[] = () => [],
    now: () => number = () => Date.now(),
    hooks: Pick<RemoteHostOptions, 'onSetupTokenRedeemed'> = {},
  ) {
    savedRecords = [];
    approvals = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl,
      saveAcl: (_hostId, records) => {
        savedRecords = [...records];
      },
      requestApproval: (pending) => approvals.push(pending),
      dismissApproval: () => {},
      ...hooks,
      now,
    });
    host.start();
    socket.open();
    return host;
  }

  beforeEach(() => {
    socket = new FakeSocket();
    authProbe.gates.length = 0;
    authProbe.calls = 0;
  });

  it('pair → local approval → pair-result with the ACL record, and persists', () => {
    makeHost();
    const request: PairingRequest = {
      accountId: 'owner',
      passkeyCredentialId: 'cred-1',
      passkeyPublicKeyHash: 'hash-1',
      devicePublicKey: 'device-1',
      requestedLabel: 'iPhone Safari',
    };
    socket.receive({ t: 'pair', clientId: 'c1', request });

    // No ACL write until the local user approves.
    expect(socket.frames('pair-result')).toHaveLength(0);
    expect(approvals).toHaveLength(1);

    approvals[0]!.approve();

    const result = socket.frames('pair-result')[0]!;
    expect(result).toMatchObject({ clientId: 'c1', approved: true });
    expect((result.record as HostAclRecord).devicePublicKey).toBe('device-1');
    expect((result.record as HostAclRecord).label).toBe('iPhone Safari');
    // The approval wrote and persisted the ACL.
    expect(savedRecords).toHaveLength(1);
    expect(savedRecords[0]!.passkeyCredentialId).toBe('cred-1');
  });

  it.each([
    ['a missing request', undefined],
    ['a non-object request', 'not-an-object'],
    ['a request missing devicePublicKey', { accountId: 'owner', passkeyCredentialId: 'c', passkeyPublicKeyHash: 'h', requestedLabel: 'x' }],
    ['a request with a non-string label', { accountId: 'owner', passkeyCredentialId: 'c', passkeyPublicKeyHash: 'h', devicePublicKey: 'd', requestedLabel: { evil: true } }],
  ])('malformed pair frame (%s) is denied and never reaches the approval UI', (_label, request) => {
    makeHost();
    // The relay is not trusted, so the Host runs the same shape guard the
    // Server does. Unguarded, these reach the modal, where rendering them
    // throws inside the app-wide ErrorBoundary and takes every terminal down.
    socket.receive({ t: 'pair', clientId: 'c1', request });

    expect(approvals).toHaveLength(0);
    expect(socket.frames('pair-result')[0]).toMatchObject({
      clientId: 'c1',
      approved: false,
      error: 'malformed-request',
    });
    expect(savedRecords).toHaveLength(0);
  });

  /** The QR-less pairing every setup-proof test varies from. */
  const PAIRING: PairingRequest = {
    accountId: 'owner',
    passkeyCredentialId: 'cred-1',
    passkeyPublicKeyHash: 'hash-1',
    devicePublicKey: 'device-1',
    requestedLabel: 'iPhone Safari',
  };

  /**
   * Send a `pair` and wait for it to land. Verifying a setup proof is a
   * WebCrypto HMAC, so an approval carrying one arrives a turn of the event loop
   * after `receive` rather than inside it.
   */
  async function pair(clientId: string, request: unknown): Promise<PendingPairing> {
    const before = approvals.length;
    socket.receive({ t: 'pair', clientId, request });
    for (let i = 0; i < 50 && approvals.length === before; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    return approvals.at(-1)!;
  }

  it('verifies a proof over its own nonce, and does not spend it on arrival', async () => {
    const host = makeHost();
    const nonce = host.mintSetupNonce(Date.now() + 60_000);
    const setupProof = await computeSetupProof(nonce, PAIRING.devicePublicKey);

    const first = await pair('c1', { ...PAIRING, setupProof });
    expect(first.verified).toBe(true);
    // The proof never travels on: `verified` is what the modal and the mirrored
    // queue get. Cast because `MirroredPairingRequest` has no such field — this
    // is the runtime half of that claim.
    expect((first.request as PairingRequest).setupProof).toBeUndefined();

    // Verification is non-consuming. The relay may re-deliver the same phone's
    // frame, and a replay carrying the same device key is asking for exactly
    // what the user is about to approve — so it must not silently downgrade.
    expect((await pair('c2', { ...PAIRING, setupProof })).verified).toBe(true);
    expect(socket.frames('pair-result')).toEqual([]);
  });

  it('never verifies a proof bound to a different device key', async () => {
    // The security property the whole scheme exists for. A hostile Server sees
    // the relayed pairing request and can substitute its own `devicePublicKey`,
    // but the proof it can copy was computed over the phone's key — and it has
    // never seen the nonce, so it cannot compute one over its own.
    const host = makeHost();
    const nonce = host.mintSetupNonce(Date.now() + 60_000);
    const phonesProof = await computeSetupProof(nonce, 'phone-key');

    const substituted = await pair('c1', {
      ...PAIRING,
      devicePublicKey: 'server-key',
      setupProof: phonesProof,
    });
    expect(substituted.verified).toBe(false);
    // The real phone's own request still verifies, so this is a rejection of
    // the substitution rather than of the ceremony.
    expect(
      (await pair('c2', { ...PAIRING, devicePublicKey: 'phone-key', setupProof: phonesProof }))
        .verified,
    ).toBe(true);
  });

  it('spends the nonce when a verified pairing is approved, and downgrades the rest', async () => {
    const host = makeHost();
    const nonce = host.mintSetupNonce(Date.now() + 60_000);
    const setupProof = await computeSetupProof(nonce, PAIRING.devicePublicKey);

    const winner = await pair('c1', { ...PAIRING, setupProof });
    const other = await pair('c2', { ...PAIRING, setupProof });
    expect([winner.verified, other.verified]).toEqual([true, true]);

    // One scan sets up one phone: approving is what the nonce authorized, so
    // that is where it is spent.
    winner.approve();
    // Everything still standing on it is re-surfaced unverified, so the modal
    // goes back to asking for the fingerprint compare rather than keeping copy
    // that is no longer true.
    const downgraded = approvals.at(-1)!;
    expect(downgraded.clientId).toBe('c2');
    expect(downgraded.verified).toBe(false);
    expect(downgraded.pairingId).toBe(other.pairingId);
    // And a later request holding the same proof is an ordinary pairing.
    expect((await pair('c3', { ...PAIRING, setupProof })).verified).toBe(false);
  });

  it('never verifies an expired nonce, and drops it on the next mint', async () => {
    const host = makeHost();
    const stale = host.mintSetupNonce(Date.now() - 1);
    // Minting a second code prunes the first, whether or not anyone asks about
    // it — nothing else sweeps that map.
    const fresh = host.mintSetupNonce(Date.now() + 60_000);

    expect(
      (await pair('c1', { ...PAIRING, setupProof: await computeSetupProof(stale, 'device-1') }))
        .verified,
    ).toBe(false);
    expect(
      (await pair('c2', { ...PAIRING, setupProof: await computeSetupProof(fresh, 'device-1') }))
        .verified,
    ).toBe(true);
  });

  it('pairs unverified with no proof, and with one nothing minted', async () => {
    const host = makeHost();
    expect((await pair('c1', PAIRING)).verified).toBe(false);
    // Nothing minted, so nothing to compute against — and no MAC is computed.
    expect((await pair('c2', { ...PAIRING, setupProof: 'forged' })).verified).toBe(false);
    host.mintSetupNonce(Date.now() + 60_000);
    expect((await pair('c3', { ...PAIRING, setupProof: 'forged' })).verified).toBe(false);

    // All three still reach the modal: an unverifiable proof costs the
    // fingerprint compare, not the pairing.
    expect(approvals).toHaveLength(3);
    expect(socket.frames('pair-result')).toEqual([]);
  });

  it('bounds proofs in flight, since a verification is not on the queue yet', async () => {
    // Verification is async, so the pending-pairing cap cannot see a request
    // that has not landed. Unbounded, a relay flooding proof-carrying frames
    // while a QR is up buys concurrent MAC computations in the process that
    // owns every PTY.
    const host = makeHost();
    const nonce = host.mintSetupNonce(Date.now() + 60_000);
    const setupProof = await computeSetupProof(nonce, PAIRING.devicePublicKey);

    const flood = 200;
    for (let i = 0; i < flood; i += 1) {
      socket.receive({ t: 'pair', clientId: `f${i}`, request: { ...PAIRING, setupProof } });
    }
    for (let i = 0; i < 50 && approvals.length < flood; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    // Every frame still pairs; past the cap it simply skips verification, which
    // is the safe degradation — the fingerprint compare.
    expect(approvals).toHaveLength(flood);
    expect(approvals.filter((pending) => pending.verified).length).toBeLessThanOrEqual(
      MAX_PENDING_PAIRINGS,
    );
    // And the modal queue itself is still capped.
    expect(host.trackedClientCount).toBeLessThanOrEqual(MAX_PENDING_PAIRINGS);
  });

  it('caps the nonces it holds at the Server’s own bound', () => {
    // The two sides of one credential: a Host that kept nonces the Server had
    // already evicted would mark a pairing verified against a token that can no
    // longer be redeemed.
    const host = makeHost();
    const nonces = Array.from({ length: MAX_TOKENS_PER_HOST + 2 }, () =>
      host.mintSetupNonce(Date.now() + 60_000),
    );
    expect(new Set(nonces).size).toBe(nonces.length);
    expect(host.outstandingSetupNonceCount).toBe(MAX_TOKENS_PER_HOST);
  });

  it('builds the mirrored request from the fields it knows, and no others', async () => {
    // `isPairingRequest` allows extras, so a spread would forward whatever else
    // the relay attached into the mirrored queue and the persisted ACL record.
    makeHost();
    const pending = await pair('c1', { ...PAIRING, injected: 'from-the-relay' });

    expect(Object.keys(pending.request).sort()).toEqual([
      'accountId',
      'devicePublicKey',
      'passkeyCredentialId',
      'passkeyPublicKeyHash',
      'requestedLabel',
    ]);
    pending.approve();
    expect(JSON.stringify(savedRecords)).not.toContain('from-the-relay');
  });

  it('routes setup-token-redeemed, the one frame that addresses no client', () => {
    const redeemed: string[] = [];
    makeHost(
      () => [],
      () => Date.now(),
      { onSetupTokenRedeemed: (mintId) => redeemed.push(mintId) },
    );
    socket.receive({ t: 'setup-token-redeemed', mintId: 'mint-1' });
    // It names the mint, never the token, so a Host showing several codes can
    // retire the right one.
    expect(redeemed).toEqual(['mint-1']);
    // The relay is not trusted to have stamped one.
    socket.receive({ t: 'setup-token-redeemed' });
    expect(redeemed).toEqual(['mint-1']);
    // It carries no clientId by design, so it must be routed before the
    // addressed-frame narrowing rather than dropped by it.
    expect(socket.sent).toEqual([]);
  });

  it('bounds and strips requestedLabel before it reaches the approval UI', () => {
    makeHost();
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        passkeyCredentialId: 'cred-1',
        passkeyPublicKeyHash: 'hash-1',
        devicePublicKey: 'device-1',
        // A bidi override plus far more text than the modal can show.
        requestedLabel: `\u202eiPhone${'A'.repeat(500)}`,
        accountId: `\u202eowner${'B'.repeat(500)}`,
      },
    });

    const shown = approvals[0]!.request.requestedLabel;
    expect(shown).not.toContain('\u202e');
    expect(Array.from(shown).length).toBeLessThanOrEqual(64);
    // `accountId` is the modal's other rendered field and is just as
    // attacker-chosen; bounding one without the other only moves the overflow.
    expect(Array.from(approvals[0]!.request.accountId).length).toBeLessThanOrEqual(64);

    approvals[0]!.approve();
    // The bound applies to what is persisted too, not only to what is shown.
    expect(Array.from(savedRecords[0]!.label).length).toBeLessThanOrEqual(64);
  });

  it('bounds pending pairings so pair frames cannot grow the host unbounded', () => {
    const host = makeHost();
    // Every `pair` frame allocates under a relay-chosen clientId, and
    // `client-gone` — the only thing that removes one — is what a hostile relay
    // simply never sends. Unbounded, 5000 frames retained 5000 requests holding
    // megabytes of relay-chosen strings in the process that owns every PTY.
    const sent = 200;
    for (let i = 0; i < sent; i++) {
      socket.receive({
        t: 'pair',
        clientId: `c${i}`,
        request: {
          accountId: 'owner',
          passkeyCredentialId: `cred-${i}`,
          passkeyPublicKeyHash: `hash-${i}`,
          devicePublicKey: `device-${i}`,
          requestedLabel: `iPhone ${i}`,
        },
      });
    }

    // `approvals` is the harness's cumulative call log, so it counts every
    // request ever shown — the live queue is what is bounded. Evictions are
    // observable as denials on the wire, which is also the point: an evicted
    // client is told, rather than left waiting on a modal that no longer
    // exists.
    const denials = socket.frames('pair-result').filter((f) => f.approved === false);
    expect(denials).toHaveLength(sent - MAX_PENDING_PAIRINGS);
    expect(denials.every((f) => f.error === 'superseded')).toBe(true);
    // The record is dropped, not just the payload it holds: evicting only
    // `pending` would free the capped request and keep the slot plus its
    // relay-chosen key forever, which is the unbounded half. This bounds the
    // pairing path — `connect` frames allocate through a different route that
    // this counter deliberately does not evict.
    expect(host.trackedClientCount).toBeLessThanOrEqual(MAX_PENDING_PAIRINGS);

    // Nothing reached the ACL without a human.
    expect(savedRecords).toHaveLength(0);
  });

  it('deny → pair-result approved:false, ACL untouched', () => {
    makeHost();
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: 'cred-1',
        passkeyPublicKeyHash: 'hash-1',
        devicePublicKey: 'device-1',
        requestedLabel: 'iPhone Safari',
      } satisfies PairingRequest,
    });
    approvals[0]!.deny();

    const result = socket.frames('pair-result')[0]!;
    expect(result).toMatchObject({ clientId: 'c1', approved: false });
    expect(result.record).toBeUndefined();
    expect(savedRecords).toEqual([]);
  });

  it('ignores approval callbacks superseded under the same client id', () => {
    makeHost();
    const first = {
      accountId: 'owner',
      passkeyCredentialId: 'cred-1',
      passkeyPublicKeyHash: 'hash-1',
      devicePublicKey: 'device-1',
      requestedLabel: 'iPhone Safari',
    } satisfies PairingRequest;
    socket.receive({ t: 'pair', clientId: 'c1', request: first });
    const stale = approvals[0]!;

    const replacement = {
      ...first,
      devicePublicKey: 'device-2',
      requestedLabel: 'Android Chrome',
    };
    socket.receive({ t: 'pair', clientId: 'c1', request: replacement });
    expect(approvals[1]!.pairingId).not.toBe(stale.pairingId);

    stale.approve();
    stale.deny();
    expect(socket.frames('pair-result')).toEqual([]);
    expect(savedRecords).toEqual([]);

    approvals[1]!.approve();
    expect(socket.frames('pair-result')[0]).toMatchObject({
      approved: true,
      record: { devicePublicKey: 'device-2' },
    });
  });

  it('expired approval → pair-result approved:false, ACL untouched', () => {
    let now = 1_000;
    makeHost(() => [], () => now);
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: 'cred-1',
        passkeyPublicKeyHash: 'hash-1',
        devicePublicKey: 'device-1',
        requestedLabel: 'iPhone Safari',
      } satisfies PairingRequest,
    });
    now += DEFAULT_PAIRING_TTL_MS;

    approvals[0]!.approve();

    const result = socket.frames('pair-result')[0]!;
    expect(result).toMatchObject({
      clientId: 'c1',
      approved: false,
      error: 'pairing approval expired',
    });
    expect(result.record).toBeUndefined();
    expect(savedRecords).toEqual([]);
  });

  it('answers pair-status from the ACL without minting client state', () => {
    const host = makeHost();
    socket.receive({
      t: 'pair-status',
      clientId: 'c1',
      query: { passkeyCredentialId: 'cred-1', devicePublicKey: 'device-1' },
    });

    expect(socket.frames('pair-status-result')[0]).toMatchObject({
      clientId: 'c1',
      paired: false,
    });
    // Inert by construction: no approval surfaced, no ticket minted, and
    // nothing tracked under the relay-chosen clientId that asking could grow.
    expect(approvals).toHaveLength(0);
    expect(host.trackedClientCount).toBe(0);
  });

  it('answers pair-status true only for a pair on one active record', () => {
    makeHost();
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: 'cred-1',
        passkeyPublicKeyHash: 'hash-1',
        devicePublicKey: 'device-1',
        requestedLabel: 'iPhone Safari',
      } satisfies PairingRequest,
    });
    approvals[0]!.approve();

    socket.sent.length = 0;
    socket.receive({
      t: 'pair-status',
      clientId: 'c1',
      query: { passkeyCredentialId: 'cred-1', devicePublicKey: 'device-1' },
    });
    expect(socket.frames('pair-status-result')[0]!.paired).toBe(true);

    // A record authorizes the PAIR, so the same passkey on a second browser is
    // not paired — the display answer has to agree with `authorizeConnection`
    // on that or it sends the user to a Connect the Host will deny.
    socket.sent.length = 0;
    socket.receive({
      t: 'pair-status',
      clientId: 'c1',
      query: { passkeyCredentialId: 'cred-1', devicePublicKey: 'device-2' },
    });
    expect(socket.frames('pair-status-result')[0]!.paired).toBe(false);
  });

  it('answers a malformed pair-status query instead of leaving the client waiting', () => {
    makeHost();
    // The client awaits exactly one frame per query, so silence strands that
    // wait until the socket dies; `false` only ever offers Pair, whose approval
    // is local anyway.
    socket.receive({ t: 'pair-status', clientId: 'c1', query: { devicePublicKey: 42 } });

    expect(socket.frames('pair-status-result')[0]).toMatchObject({
      clientId: 'c1',
      paired: false,
    });
    expect(savedRecords).toHaveLength(0);
  });

  it('connect issues a challenge frame', () => {
    makeHost();
    socket.receive({ t: 'connect', clientId: 'c1' });
    const challenge = socket.frames('challenge')[0]!;
    expect(challenge.clientId).toBe('c1');
    expect(typeof challenge.challenge).toBe('string');
    expect(typeof challenge.expiresAt).toBe('number');
  });

  it('connect2 for an unpaired device denies with failures', async () => {
    makeHost();
    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();

    const decision = await runConnect(socket, 'c1', async (challenge) => ({
      accountId: 'owner',
      devicePublicKey: deviceKey.devicePublicKey,
      challenge,
      deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
        hostId: ENROLLMENT.hostId,
        challenge,
        devicePublicKey: deviceKey.devicePublicKey,
      }),
      passkey: {
        publicKey: authenticator.publicKey,
        assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
      },
    }));

    expect(decision).toMatchObject({ clientId: 'c1', allowed: false });
    expect(decision.failures).toEqual(
      expect.arrayContaining(['passkey-not-paired', 'device-not-paired']),
    );
  });

  it('contains and denies a malformed connect2 from the relay', async () => {
    makeHost();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    socket.receive({ t: 'connect2', clientId: 'c1', request: {} });

    const decision = await flushUntil(() => socket.frames('decision')[0]);
    expect(decision).toMatchObject({ clientId: 'c1', allowed: false });
    expect(decision.failures).toEqual(
      expect.arrayContaining(['passkey-assertion-invalid', 'device-signature-invalid']),
    );
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('pair then connect2 allows and omits failures', async () => {
    makeHost();
    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();
    const passkeyPublicKeyHash = await hashPasskeyPublicKey(authenticator.publicKey);

    // Pair this exact (passkey, device) pair through the real ceremony.
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: authenticator.credentialId,
        passkeyPublicKeyHash,
        devicePublicKey: deviceKey.devicePublicKey,
        requestedLabel: 'iPhone Safari',
      } satisfies PairingRequest,
    });
    approvals[0]!.approve();
    expect(socket.frames('pair-result')[0]).toMatchObject({ approved: true });

    const decision = await runConnect(socket, 'c1', async (challenge) => ({
      accountId: 'owner',
      devicePublicKey: deviceKey.devicePublicKey,
      challenge,
      deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
        hostId: ENROLLMENT.hostId,
        challenge,
        devicePublicKey: deviceKey.devicePublicKey,
      }),
      passkey: {
        publicKey: authenticator.publicKey,
        assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
      },
    }));

    expect(decision).toMatchObject({ clientId: 'c1', allowed: true });
    // `failures` is omitted from an allowed decision.
    expect('failures' in decision).toBe(false);
  });

  it('gates msg on an allowed decision and routes to a session', async () => {
    const handled: unknown[] = [];
    let disposed = 0;
    savedRecords = [];
    approvals = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: (pending) => pending.approve(),
      dismissApproval: () => {},
      createSession: () => ({
        handle: (data) => handled.push(data),
        dispose: () => {
          disposed += 1;
        },
      }),
    });
    host.start();
    socket.open();

    // Before any allowed decision, msg is dropped (the host-side gate).
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r', method: 'hello' } });
    expect(handled).toHaveLength(0);

    // Force an allowed decision by pairing + connecting.
    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();
    const passkeyPublicKeyHash = await hashPasskeyPublicKey(authenticator.publicKey);
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: authenticator.credentialId,
        passkeyPublicKeyHash,
        devicePublicKey: deviceKey.devicePublicKey,
        requestedLabel: 'x',
      } satisfies PairingRequest,
    });
    await runConnect(socket, 'c1', async (challenge) => ({
      accountId: 'owner',
      devicePublicKey: deviceKey.devicePublicKey,
      challenge,
      deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
        hostId: ENROLLMENT.hostId,
        challenge,
        devicePublicKey: deviceKey.devicePublicKey,
      }),
      passkey: {
        publicKey: authenticator.publicKey,
        assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
      },
    }));

    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r', method: 'hello' } });
    expect(handled).toHaveLength(1);

    // A new, malformed authorization attempt fails closed and revokes this
    // connection's message gate. The relay is not an authority merely because
    // this clientId was allowed once.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    socket.sent.length = 0;
    socket.receive({ t: 'connect2', clientId: 'c1', request: {} });
    await flushUntil(() => socket.frames('decision')[0]);
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r2', method: 'hello' } });
    expect(handled).toHaveLength(1);
    expect(disposed).toBe(1);
    warn.mockRestore();

    // client-gone disposes the session and re-gates.
    socket.receive({ t: 'client-gone', clientId: 'c1' });
    // The failed re-authorization already disposed it; client-gone is
    // idempotent rather than disposing the old session twice.
    expect(disposed).toBe(1);
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r3', method: 'hello' } });
    expect(handled).toHaveLength(1);
  });

  it('lets only the newest connect2 answer, even when an older one lands last', async () => {
    // Verification is async and the relay can start a second attempt while the
    // first is still running. An older `allowed` landing last would re-open the
    // gate the newer attempt closed — the relay would then have talked this Host
    // into establishing a client it had just denied.
    const handled: unknown[] = [];
    savedRecords = [];
    approvals = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      reconnect: false,
      createWebSocket: () => (socket = new FakeSocket()),
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: (pending) => pending.approve(),
      dismissApproval: () => {},
      createSession: () => ({ handle: (data) => handled.push(data), dispose: () => {} }),
    });
    host.start();
    socket.open();

    const authenticator = await createAuthenticator(ENROLLMENT.rpId);
    const deviceKey = await generateDeviceKeyPair();
    const passkeyPublicKeyHash = await hashPasskeyPublicKey(authenticator.publicKey);
    socket.receive({
      t: 'pair',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        passkeyCredentialId: authenticator.credentialId,
        passkeyPublicKeyHash,
        devicePublicKey: deviceKey.devicePublicKey,
        requestedLabel: 'x',
      } satisfies PairingRequest,
    });

    // The older attempt would be allowed — and is held open until after the
    // newer one has been answered.
    const held = gate();
    authProbe.gates[authProbe.calls] = held.promise;
    socket.sent.length = 0;
    socket.receive({ t: 'connect', clientId: 'c1' });
    const challenge = socket.frames('challenge')[0]!.challenge as string;
    socket.receive({
      t: 'connect2',
      clientId: 'c1',
      request: {
        accountId: 'owner',
        devicePublicKey: deviceKey.devicePublicKey,
        challenge,
        deviceSignature: await signDeviceChallenge(deviceKey.privateKey, {
          hostId: ENROLLMENT.hostId,
          challenge,
          devicePublicKey: deviceKey.devicePublicKey,
        }),
        passkey: {
          publicKey: authenticator.publicKey,
          assertion: await authenticator.assert(challenge, ENROLLMENT.origin),
        },
      } satisfies ConnectionRequest,
    });
    await settle();
    expect(socket.frames('decision')).toHaveLength(0);

    // The newer attempt is malformed, so it denies and closes the gate.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    socket.receive({ t: 'connect2', clientId: 'c1', request: {} });
    expect(await flushUntil(() => socket.frames('decision')[0])).toMatchObject({ allowed: false });

    held.release();
    await settle();

    // The superseded evaluation answers nothing at all — a second `decision`
    // would settle a request the client is no longer waiting on.
    expect(socket.frames('decision')).toHaveLength(1);
    socket.receive({ t: 'msg', clientId: 'c1', data: { requestId: 'r', method: 'hello' } });
    expect(handled).toHaveLength(0);
    warn.mockRestore();
  });
});

describe('RemoteHost close-code policy', () => {
  /** Every socket the host has opened, in order. */
  let sockets: FakeSocket[] = [];
  let live: RemoteHost | null = null;

  /** A host with the real reconnect policy (backoff timers under fake timers). */
  function makeHost(): RemoteHost {
    sockets = [];
    const host = new RemoteHost({
      enrollment: ENROLLMENT,
      createWebSocket: () => {
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: () => {},
      dismissApproval: () => {},
    });
    live = host;
    host.start();
    sockets[0]!.open();
    expect(host.status).toBe('connected');
    return host;
  }

  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    live?.stop();
    live = null;
    vi.useRealTimers();
  });

  it('reconnects after a transient close', () => {
    const host = makeHost();

    sockets[0]!.closeWith(1006); // abnormal closure — a Wi-Fi blip
    expect(host.status).toBe('disconnected');
    expect(sockets).toHaveLength(1);

    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(host.status).toBe('connected');
  });

  it('stands down on a displacement close instead of reconnecting', () => {
    const host = makeHost();

    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('displaced');

    // No timer brings it back — fighting the newer Host for the hostId is the
    // bug this close code exists to prevent.
    vi.advanceTimersByTime(10 * 60_000);
    expect(sockets).toHaveLength(1);
    expect(host.status).toBe('displaced');
  });

  it('start() is the explicit way back from displaced', () => {
    const host = makeHost();
    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('displaced');

    host.start();
    expect(sockets).toHaveLength(2);
    sockets[1]!.open();
    expect(host.status).toBe('connected');

    // And the reconnect policy is intact afterwards.
    sockets[1]!.closeWith(1006);
    vi.advanceTimersByTime(1_000);
    expect(sockets).toHaveLength(3);
  });

  it('ignores a close from a socket it no longer owns', () => {
    const host = makeHost();
    sockets[0]!.closeWith(1006);
    vi.advanceTimersByTime(1_000);
    sockets[1]!.open();
    expect(host.status).toBe('connected');

    // The relay evicts the *dead* first socket. That close says nothing about
    // the live one, so it must not stand this Host down.
    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('connected');
    expect(sockets).toHaveLength(2);
  });

  it('stop() wins over a displacement close', () => {
    const host = makeHost();
    host.stop();
    expect(host.status).toBe('stopped');

    // `stop()` drops the socket reference without waiting for its close event.
    sockets[0]!.closeWith(WS_CLOSE_HOST_REPLACED);
    expect(host.status).toBe('stopped');
  });
});

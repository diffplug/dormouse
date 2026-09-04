/**
 * In-memory actors simulating the three parties of the remote security model
 * (docs/specs/remote-security-model.md): Client (Dormouse Pocket), Burrow
 * (Dormouse Terminal), and coordinating Relay.
 *
 * Everything here runs the *real* primitives — the QR grammar and its parser,
 * the IK handshake against the invitation key and then the pinned Burrow static,
 * the fixed-size padded control messages, the one presence verifier, the Burrow
 * challenge issuer, and the Burrow ACL. Only the relay is imaginary: a Client
 * hands its Noise messages straight to a Burrow object.
 *
 * Tampering is a first-class feature: every actor accepts overrides so tests
 * can forge exactly one field at a time and assert the precise deny reason.
 */

import {
  BurrowAcl,
  ChallengeIssuer,
  NoiseTransportSession,
  boundedPairingLabel,
  concatBytes,
  createNoiseInitiator,
  createNoiseResponder,
  e2eConnectionPrologue,
  ecdsaRawToDer,
  formatPairingInvitationUrl,
  fromBase64Url,
  generateNoiseKeyPair,
  isConnectionOutcomeV1,
  isConnectionRequestV1,
  isPairingOutcomeV1,
  isPairingRequestV1,
  pairingInvitationPrologue,
  parsePairingInvitationUrl,
  presenceChallenge,
  samplePairingCode,
  toBase64Url,
  utf8Encode,
  verifyPresenceProof,
} from '../../dist/index.js';

const subtle = globalThis.crypto.subtle;

async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
}

function randomBytes(count) {
  return globalThis.crypto.getRandomValues(new Uint8Array(count));
}

/** Base64url of 16 random bytes — the shape of every routing id on this wire. */
export function randomRoutingId() {
  return toBase64Url(randomBytes(16));
}

/** Base64url of 32 random bytes — setup tokens, delivery ids, Relay nonces. */
export function randomSecret() {
  return toBase64Url(randomBytes(32));
}

/** A SimBurrow, or a bare burrowId string; both name one Burrow to these actors. */
function burrowIdOf(burrow) {
  return typeof burrow === 'string' ? burrow : burrow.burrowId;
}

/** Deterministic, manually-advanced clock shared by actors in a scenario. */
export class FakeClock {
  #ms;

  constructor(startMs = 1_700_000_000_000) {
    this.#ms = startMs;
  }

  now = () => this.#ms;

  advance(ms) {
    this.#ms += ms;
  }
}

/**
 * A passkey. WebAuthn is simulated faithfully enough to exercise the real
 * verifier: clientDataJSON, authenticatorData (rpIdHash/flags/signCount), and
 * a DER-encoded ES256 signature over `authData || sha256(clientDataJSON)`.
 *
 * Passkeys sync across devices: sharing one SimAuthenticator instance between
 * two SimClients models exactly that.
 */
export class SimAuthenticator {
  static async create({ rpId, userVerification = true } = {}) {
    const keyPair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
      'sign',
      'verify',
    ]);
    const spki = new Uint8Array(await subtle.exportKey('spki', keyPair.publicKey));
    const credentialId = toBase64Url(globalThis.crypto.getRandomValues(new Uint8Array(16)));
    return new SimAuthenticator({ keyPair, spki, credentialId, rpId, userVerification });
  }

  #keyPair;
  #signCount = 0;

  constructor({ keyPair, spki, credentialId, rpId, userVerification }) {
    this.#keyPair = keyPair;
    this.credentialId = credentialId;
    this.publicKey = toBase64Url(spki);
    this.rpId = rpId;
    this.userVerification = userVerification;
  }

  /**
   * Produce an authentication assertion. `tamper` forges individual pieces:
   *   { type, challenge, origin, rpId, userPresent, userVerified, signWith }
   */
  async assert({ challenge, origin, rpId = this.rpId, tamper = {} }) {
    const clientData = {
      type: tamper.type ?? 'webauthn.get',
      challenge: tamper.challenge ?? challenge,
      origin: tamper.origin ?? origin,
      crossOrigin: false,
    };
    const clientDataJSON = utf8Encode(JSON.stringify(clientData));

    const rpIdHash = await sha256(utf8Encode(tamper.rpId ?? rpId));
    const userPresent = tamper.userPresent ?? true;
    const userVerified = tamper.userVerified ?? this.userVerification;
    const flags = (userPresent ? 0x01 : 0x00) | (userVerified ? 0x04 : 0x00);
    this.#signCount += 1;
    const authenticatorData = concatBytes(
      rpIdHash,
      Uint8Array.of(
        flags,
        (this.#signCount >>> 24) & 0xff,
        (this.#signCount >>> 16) & 0xff,
        (this.#signCount >>> 8) & 0xff,
        this.#signCount & 0xff,
      ),
    );

    const signingKey = tamper.signWith ?? this.#keyPair.privateKey;
    const rawSignature = new Uint8Array(
      await subtle.sign(
        { name: 'ECDSA', hash: 'SHA-256' },
        signingKey,
        concatBytes(authenticatorData, await sha256(clientDataJSON)),
      ),
    );

    return {
      credentialId: this.credentialId,
      clientDataJSON: toBase64Url(clientDataJSON),
      authenticatorData: toBase64Url(authenticatorData),
      signature: toBase64Url(ecdsaRawToDer(rawSignature)),
    };
  }

  /** A different private key, for signature-forgery tests. */
  static async foreignSigningKey() {
    const pair = await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign']);
    return pair.privateKey;
  }
}

/**
 * The coordinating Relay: accounts, passkey registration, and the presence
 * challenge it mints for one ceremony (`POST /api/reauth/begin`). Never
 * authoritative — it learns only routing values and a handshake hash, and its
 * answer authorizes nothing.
 */
export class SimServer {
  #accounts = new Map(); // accountId -> Set of credentialIds

  registerAccount(accountId) {
    if (!this.#accounts.has(accountId)) this.#accounts.set(accountId, new Set());
  }

  registerPasskey(accountId, authenticator) {
    this.registerAccount(accountId);
    this.#accounts.get(accountId).add(authenticator.credentialId);
  }

  /** Requirement 2: "The Relay recognizes the account." */
  validateAccount(accountId, credentialId) {
    const credentials = this.#accounts.get(accountId);
    if (!credentials) throw new Error(`server: unknown account ${accountId}`);
    if (!credentials.has(credentialId)) {
      throw new Error(`server: credential ${credentialId} not registered to ${accountId}`);
    }
  }

  /**
   * Mint the WebAuthn challenge for one presence proof. The challenge is
   * derived from the binding, so an assertion produced here authenticates only
   * the ceremony that binding names.
   */
  async beginReauth({ accountId, credentialId, binding }) {
    this.validateAccount(accountId, credentialId);
    const relayNonce = randomSecret();
    return {
      relayNonce,
      challenge: await presenceChallenge(binding, relayNonce),
      allowCredentials: [credentialId],
    };
  }
}

/**
 * A compromised coordinating Relay: vouches for anyone. Used to prove the
 * Burrow denies access even when every Relay-side check is attacker-controlled.
 */
export class CompromisedServer extends SimServer {
  validateAccount() {}
}

/**
 * The Burrow (Dormouse Terminal): the ACL, the challenge issuer, one long-term
 * Noise static, and the per-invitation one-use keypairs. It is the only party
 * that writes the ACL, and the only one that decides a connection.
 */
export class SimBurrow {
  static async create({
    burrowId = randomRoutingId(),
    label = 'Laptop',
    rpId,
    origin,
    clock = new FakeClock(),
    policy = {},
    ttlMs,
    invitationTtlSeconds = 300,
  } = {}) {
    const burrow = new SimBurrow({ burrowId, label, rpId, origin, clock, policy, ttlMs, invitationTtlSeconds });
    // The long-term static a paired Client pins and every later connection
    // runs IK against. Public: the Burrow hands it out in every PairingOutcomeV1.
    burrow.staticKeyPair = await generateNoiseKeyPair();
    burrow.staticPublicKey = toBase64Url(burrow.staticKeyPair.publicKey);
    return burrow;
  }

  /** inviteId -> { invitation, keyPair, state, session, clientStaticPublicKey } */
  #invitations = new Map();
  /** connectionId -> { session, clientStaticPublicKey, challenge } */
  #connections = new Map();

  constructor({ burrowId, label, rpId, origin, clock, policy, ttlMs, invitationTtlSeconds }) {
    this.burrowId = burrowId;
    this.label = label;
    this.clock = clock;
    this.invitationTtlSeconds = invitationTtlSeconds;
    this.policy = { rpId, origin, ...policy };
    // The origin the Burrow enrolled against, and the only prefix its QR carries.
    this.appOrigin =
      typeof this.policy.origin === 'string' ? this.policy.origin : this.policy.origin[0];
    this.acl = new BurrowAcl(burrowId, { now: clock.now });
    this.challenges = new ChallengeIssuer({ now: clock.now, ttlMs });
  }

  issueChallenge() {
    return this.challenges.issue();
  }

  /** The state the QR panel renders: `live`, `reserved`, `consumed`, or absent. */
  invitationState(inviteId) {
    return this.#invitations.get(inviteId)?.state;
  }

  /**
   * Mint one invitation: a 16-byte id, an expiry, the Relay's setup token, and
   * a one-use X25519 responder keypair. The long-term static is deliberately
   * absent — a first-time Client has no key to check a signature with, so IK
   * possession of the scanned key is what it gets instead.
   */
  async mintInvitation({ ttlSeconds = this.invitationTtlSeconds } = {}) {
    const keyPair = await generateNoiseKeyPair();
    const invitation = {
      burrowId: this.burrowId,
      inviteId: randomRoutingId(),
      expiry: Math.floor(this.clock.now() / 1000) + ttlSeconds,
      setupToken: randomSecret(),
      ephPub: keyPair.publicKey,
      ephPubBase64Url: toBase64Url(keyPair.publicKey),
    };
    this.#invitations.set(invitation.inviteId, { invitation, keyPair, state: 'live' });
    return invitation;
  }

  /** The URL the Burrow renders as its QR. */
  invitationUrl(invitation) {
    return formatPairingInvitationUrl(this.appOrigin, invitation);
  }

  /**
   * Noise message 1 against one invitation; answers message 2 with an empty
   * payload. The invitation moves to `reserved`: it accepts one request.
   */
  async readPairingInit(inviteId, message1) {
    const pending = this.#invitations.get(inviteId);
    if (!pending || pending.state !== 'live') throw new Error(`no live invitation ${inviteId}`);
    pending.state = 'reserved';
    const responder = await createNoiseResponder({
      prologue: pairingInvitationPrologue(pending.invitation),
      staticKeyPair: pending.keyPair,
    });
    await responder.readMessage(message1);
    const message2 = await responder.writeMessage();
    // IK authenticated this static: the Client proved possession of its private
    // half inside the handshake, so it is what the ACL record may bind.
    pending.clientStaticPublicKey = toBase64Url(responder.remoteStaticPublicKey);
    pending.session = new NoiseTransportSession(responder.session);
    return message2;
  }

  /**
   * The Client's first control message, the local approval, and the single
   * outcome that ends the pairing either way.
   *
   * `detail` is the owner-local reason — never on the wire: the `PairingOutcomeV1`
   * carries only one of the six fixed denial codes.
   */
  async handlePairingRequest(
    inviteId,
    ciphertext,
    { approve = true, typedCode, approvedBy = 'burrow-user', label } = {},
  ) {
    const pending = this.#invitations.get(inviteId);
    if (!pending || pending.state !== 'reserved') throw new Error(`no reserved invitation ${inviteId}`);
    const answer = (outcome, extra = {}) => ({
      ciphertext: pending.session.isPoisoned ? null : pending.session.sendControl(outcome),
      outcome,
      record: null,
      detail: null,
      ...extra,
    });
    const deny = (code, detail = null) => answer({ ok: false, code }, { detail });

    let request = null;
    try {
      const receipt = pending.session.receive(ciphertext);
      if (receipt.kind === 'control') request = receipt.value;
    } catch {
      // A ciphertext that does not authenticate poisons the session, so there
      // is nothing left to answer on.
      pending.state = 'consumed';
      return { ciphertext: null, outcome: null, record: null, detail: 'transport-failed' };
    }
    // Exactly one attempt: the invitation is spent whatever happens next.
    pending.state = 'consumed';
    if (!isPairingRequestV1(request)) return deny('burrow-error', 'malformed-request');

    const expected = {
      kind: 'pairing',
      burrowId: this.burrowId,
      handshakeHash: toBase64Url(pending.session.handshakeHash),
      // The one binding field that is not Burrow state. The verifier requires the
      // assertion and the proof to name this same credential, which is what
      // keeps the verified key and the bound identity one identity.
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, expected, this.policy);
    if (!proof.ok) return deny('presence-rejected', proof.reason);
    if (!approve) return deny('user-denied');
    // The human types what the phone displays; compare once, no retry.
    if ((typedCode ?? request.code) !== request.code) return deny('confirmation-mismatch');

    const record = this.acl.approve({
      accountId: request.presence.accountId,
      passkeyCredentialId: expected.passkeyCredentialId,
      passkeyPublicKeyHash: proof.passkeyPublicKeyHash,
      clientStaticPublicKey: pending.clientStaticPublicKey,
      deliveryId: randomSecret(),
      approvedBy,
      label: label ?? boundedPairingLabel(request.label),
    });
    return answer(
      {
        ok: true,
        burrowStaticPublicKey: this.staticPublicKey,
        burrowLabel: this.label,
        accountId: record.accountId,
        passkeyCredentialId: record.passkeyCredentialId,
        passkeyPublicKeyHash: record.passkeyPublicKeyHash,
        deliveryId: record.deliveryId,
      },
      { record },
    );
  }

  /**
   * Noise message 1 of a connection against the long-term static; answers
   * message 2 carrying a fresh 32-byte Burrow challenge as its payload.
   */
  async readConnectionInit(connectionId, message1) {
    const responder = await createNoiseResponder({
      prologue: e2eConnectionPrologue(this.burrowId, connectionId),
      staticKeyPair: this.staticKeyPair,
    });
    await responder.readMessage(message1);
    const issued = this.challenges.issue();
    const message2 = await responder.writeMessage(fromBase64Url(issued.challenge));
    this.#connections.set(connectionId, {
      session: new NoiseTransportSession(responder.session),
      clientStaticPublicKey: toBase64Url(responder.remoteStaticPublicKey),
      challenge: issued.challenge,
    });
    return message2;
  }

  /**
   * Authorization = proof ∧ conjunction. The specific miss is reported on the
   * returned object — the owner-local log — while the `ConnectionOutcomeV1`
   * itself carries only `pairing-required`. That separation is the point:
   * which half of the conjunction failed never leaves the Burrow.
   */
  async handleConnectionRequest(connectionId, ciphertext) {
    const pending = this.#connections.get(connectionId);
    if (!pending) throw new Error(`no pending connection ${connectionId}`);
    const answer = (outcome, extra = {}) => ({
      ciphertext: pending.session.isPoisoned ? null : pending.session.sendControl(outcome),
      outcome,
      detail: null,
      misses: [],
      ...extra,
    });
    const deny = (code, extra) => answer({ ok: false, code }, extra);

    let request = null;
    try {
      const receipt = pending.session.receive(ciphertext);
      if (receipt.kind === 'control') request = receipt.value;
    } catch {
      this.#connections.delete(connectionId);
      return { ciphertext: null, outcome: null, detail: 'transport-failed', misses: [] };
    }
    // Consumed before anything is verified, and whether or not the rest
    // succeeds: a captured request must never be retryable against a live
    // challenge.
    const fresh = this.challenges.consume(pending.challenge);
    this.#connections.delete(connectionId);
    if (!isConnectionRequestV1(request)) return deny('protocol-rejected', { detail: 'malformed-request' });
    if (!fresh) return deny('presence-rejected', { detail: 'challenge-invalid' });

    const expected = {
      kind: 'connection',
      burrowId: this.burrowId,
      connectionId,
      burrowChallenge: pending.challenge,
      handshakeHash: toBase64Url(pending.session.handshakeHash),
      passkeyCredentialId: request.presence.binding.passkeyCredentialId,
    };
    const proof = await verifyPresenceProof(request.presence, expected, this.policy);
    if (!proof.ok) return deny('presence-rejected', { detail: proof.reason });

    const auth = this.acl.authorize({
      passkeyCredentialId: expected.passkeyCredentialId,
      clientStaticPublicKey: pending.clientStaticPublicKey,
    });
    if (!auth.record) return deny('pairing-required', { misses: auth.reasons });
    // The record is the conjunction of four values, not two: the account and
    // the passkey key hash are checked against the same row the two identities
    // selected, so a Relay that swapped either grants nothing.
    if (auth.record.accountId !== request.presence.accountId) {
      return deny('pairing-required', { misses: ['account-mismatch'] });
    }
    if (auth.record.passkeyPublicKeyHash !== proof.passkeyPublicKeyHash) {
      return deny('pairing-required', { misses: ['passkey-key-mismatch'] });
    }
    return answer({ ok: true, burrowLabel: this.label }, { record: auth.record });
  }
}

/**
 * A Client (Dormouse Pocket): one browser profile holding one X25519 static
 * **per Burrow**, the Burrow statics it has pinned, and the passkey it signs with.
 */
export class SimClient {
  static async create({ label = 'Test Client', origin, server } = {}) {
    return new SimClient({ label, origin, server });
  }

  /** burrowId -> NoiseKeyPair; different Burrows never share a Client key. */
  #statics = new Map();

  constructor({ label, origin, server }) {
    this.label = label;
    this.origin = origin;
    this.server = server;
    /** burrowId -> the Burrow static this Client pinned at pairing, base64url. */
    this.pins = new Map();
    /** burrowId -> the fields a `KnownBurrowV1` keeps after a successful pairing. */
    this.knownBurrows = new Map();
  }

  async #staticFor(burrowId) {
    let pair = this.#statics.get(burrowId);
    if (!pair) {
      pair = await generateNoiseKeyPair();
      this.#statics.set(burrowId, pair);
    }
    return pair;
  }

  /**
   * This Client's keypair for one Burrow, or undefined if unscanned. The private
   * half is what opens a push sealed to this Client.
   */
  staticKeyPairFor(burrow) {
    return this.#statics.get(burrowIdOf(burrow));
  }

  /** This Client's static for one Burrow, base64url, or undefined if unscanned. */
  staticPublicKeyFor(burrow) {
    const pair = this.staticKeyPairFor(burrow);
    return pair ? toBase64Url(pair.publicKey) : undefined;
  }

  /**
   * Browser-data loss: this Burrow's static is gone and a fresh one replaces it.
   * Returns the lost public key so a test can revoke the stranded record.
   */
  async losePerBurrowStatic(burrow) {
    const burrowId = burrowIdOf(burrow);
    const previous = this.staticPublicKeyFor(burrowId);
    this.#statics.delete(burrowId);
    await this.#staticFor(burrowId);
    return previous;
  }

  /**
   * The proof both ceremonies carry: ask the Relay for a nonce over this
   * binding, then assert with the passkey over the challenge it derives.
   */
  async presenceProof({ binding, accountId, authenticator, rpId, server = this.server, tamper = {} }) {
    const { relayNonce, challenge } = await server.beginReauth({
      accountId,
      credentialId: authenticator.credentialId,
      binding,
    });
    const assertion = await authenticator.assert({
      challenge,
      origin: this.origin,
      rpId,
      tamper: tamper.assertion ?? {},
    });
    return {
      binding,
      relayNonce,
      accountId,
      passkeyCredentialId: authenticator.credentialId,
      passkeyPublicKey: authenticator.publicKey,
      assertion,
      ...(tamper.proof ?? {}),
    };
  }

  /**
   * The whole pairing ceremony: scan the QR, IK against the invitation key,
   * one control message carrying the proof and the displayed code, and the
   * single outcome.
   *
   * `record` on the result is the Burrow's own row — a simulation convenience for
   * assertions, never something the Client is sent.
   */
  async pair(
    burrow,
    {
      accountId,
      authenticator,
      server = this.server,
      approve = true,
      approvedBy = 'burrow-user',
      label,
      code = samplePairingCode(),
      typedCode,
      invitation,
      tamper = {},
    } = {},
  ) {
    const minted = invitation ?? (await burrow.mintInvitation());
    // The real scan path: the Burrow renders a URL, the Client parses it back.
    // Anything the parser rejects never reaches a handshake.
    const scanned = await parsePairingInvitationUrl(
      burrow.invitationUrl(minted),
      this.origin,
      burrow.clock.now(),
    );
    if (!scanned) throw new Error('the Burrow minted a QR its own Client cannot parse');

    const staticKeyPair = await this.#staticFor(scanned.burrowId);
    const initiator = await createNoiseInitiator({
      prologue: pairingInvitationPrologue(scanned),
      staticKeyPair,
      remoteStaticPublicKey: scanned.ephPub,
    });
    const message1 = await initiator.writeMessage();
    await initiator.readMessage(await burrow.readPairingInit(scanned.inviteId, message1));
    const session = new NoiseTransportSession(initiator.session);

    const binding = {
      kind: 'pairing',
      burrowId: scanned.burrowId,
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: authenticator.credentialId,
    };
    const presence =
      tamper.presence ??
      (await this.presenceProof({
        binding,
        accountId,
        authenticator,
        rpId: burrow.policy.rpId,
        server,
        tamper,
      }));
    // Pocket samples the two digits it displays; the person reads them off the
    // phone and types them on the Burrow, which is what `typedCode` models.
    const request = { code, label: this.label, presence, ...(tamper.request ?? {}) };
    const answered = await burrow.handlePairingRequest(scanned.inviteId, session.sendControl(request), {
      approve,
      typedCode: typedCode ?? code,
      approvedBy,
      label,
    });
    if (answered.ciphertext === null) {
      return { ok: false, outcome: null, presence, code, detail: answered.detail, record: null };
    }

    // Pocket accepts an outcome only after decrypting it on the session it
    // built, and only when it is one of the two shapes.
    const receipt = session.receive(answered.ciphertext);
    const outcome = receipt.kind === 'control' && isPairingOutcomeV1(receipt.value) ? receipt.value : null;
    if (outcome?.ok === true) {
      const pinned = this.pins.get(scanned.burrowId);
      if (pinned !== undefined && pinned !== outcome.burrowStaticPublicKey) {
        throw new Error('the Burrow static changed under an existing pin');
      }
      this.pins.set(scanned.burrowId, outcome.burrowStaticPublicKey);
      this.knownBurrows.set(scanned.burrowId, {
        deliveryId: outcome.deliveryId,
        accountId: outcome.accountId,
        passkeyCredentialId: outcome.passkeyCredentialId,
        passkeyPublicKeyHash: outcome.passkeyPublicKeyHash,
      });
    }
    return {
      ok: outcome?.ok === true,
      outcome,
      presence,
      code,
      detail: answered.detail,
      record: answered.record,
    };
  }

  /**
   * The whole connection ceremony: IK against the pinned Burrow static, the
   * challenge that arrives in message 2, one control message carrying the
   * proof, and the single outcome.
   *
   * `misses` is the Burrow's owner-local reason list; the outcome the Client is
   * actually sent never names it.
   */
  async connect(
    burrow,
    { accountId, authenticator, server = this.server, connectionId = randomRoutingId(), tamper = {} } = {},
  ) {
    if (server) server.validateAccount(accountId, authenticator.credentialId);
    const staticKeyPair = await this.#staticFor(burrow.burrowId);
    // An unpaired Client has no pin, so it uses the Burrow's public static
    // directly. That models an attacker who already knows it — which every
    // paired Client does — and makes the denial strictly stronger evidence.
    const remoteStatic = fromBase64Url(this.pins.get(burrow.burrowId) ?? burrow.staticPublicKey);
    const initiator = await createNoiseInitiator({
      prologue: e2eConnectionPrologue(burrow.burrowId, connectionId),
      staticKeyPair,
      remoteStaticPublicKey: remoteStatic,
    });
    const message1 = await initiator.writeMessage();
    const challengeBytes = await initiator.readMessage(
      await burrow.readConnectionInit(connectionId, message1),
    );
    const session = new NoiseTransportSession(initiator.session);

    const binding = {
      kind: 'connection',
      burrowId: burrow.burrowId,
      connectionId,
      burrowChallenge: toBase64Url(challengeBytes),
      handshakeHash: toBase64Url(session.handshakeHash),
      passkeyCredentialId: authenticator.credentialId,
    };
    const presence =
      tamper.presence ??
      (await this.presenceProof({
        binding,
        accountId,
        authenticator,
        rpId: burrow.policy.rpId,
        server,
        tamper,
      }));
    const answered = await burrow.handleConnectionRequest(
      connectionId,
      session.sendControl({ presence, ...(tamper.request ?? {}) }),
    );
    if (answered.ciphertext === null) {
      return { ok: false, outcome: null, presence, binding, detail: answered.detail, misses: [] };
    }
    const receipt = session.receive(answered.ciphertext);
    const outcome =
      receipt.kind === 'control' && isConnectionOutcomeV1(receipt.value) ? receipt.value : null;
    return {
      ok: outcome?.ok === true,
      outcome,
      presence,
      binding,
      detail: answered.detail,
      misses: answered.misses,
    };
  }
}

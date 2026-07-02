/**
 * In-memory actors simulating the three parties of the remote security model
 * (docs/specs/remote-security-model.md): Client (Dormouse Pocket), Host
 * (Dormouse Terminal), and coordinating Server. Everything runs on real
 * WebCrypto; only the transport is imaginary.
 *
 * Tampering is a first-class feature: every actor accepts overrides so tests
 * can forge exactly one field at a time and assert the precise deny reason.
 */

import {
  HostAcl,
  HostChallengeIssuer,
  PairingCeremony,
  authorizeConnection,
  concatBytes,
  ecdsaRawToDer,
  generateDeviceKeyPair,
  hashPasskeyPublicKey,
  signDeviceChallenge,
  toBase64Url,
  utf8Encode,
} from '../../dist/index.js';

const subtle = globalThis.crypto.subtle;

async function sha256(bytes) {
  return new Uint8Array(await subtle.digest('SHA-256', bytes));
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

/** The coordinating Server: accounts and passkey registration. Never authoritative. */
export class SimServer {
  #accounts = new Map(); // accountId -> Set of credentialIds

  registerAccount(accountId) {
    if (!this.#accounts.has(accountId)) this.#accounts.set(accountId, new Set());
  }

  registerPasskey(accountId, authenticator) {
    this.registerAccount(accountId);
    this.#accounts.get(accountId).add(authenticator.credentialId);
  }

  /** Requirement 2: "The Server recognizes the account." */
  validateAccount(accountId, credentialId) {
    const credentials = this.#accounts.get(accountId);
    if (!credentials) throw new Error(`server: unknown account ${accountId}`);
    if (!credentials.has(credentialId)) {
      throw new Error(`server: credential ${credentialId} not registered to ${accountId}`);
    }
  }
}

/**
 * A compromised coordinating Server: vouches for anyone. Used to prove the
 * Host denies access even when the Server-side checks are attacker-controlled.
 */
export class CompromisedServer extends SimServer {
  validateAccount() {}
}

/** The Host (Dormouse Terminal): ACL + challenges + pairing + final decision. */
export class SimHost {
  constructor({ hostId, rpId, origin, clock = new FakeClock(), policy = {}, ttlMs } = {}) {
    this.hostId = hostId;
    this.clock = clock;
    this.policy = { rpId, origin, ...policy };
    this.acl = new HostAcl(hostId, { now: clock.now });
    this.challenges = new HostChallengeIssuer({ now: clock.now, ttlMs });
    this.ceremony = new PairingCeremony(this.acl, { now: clock.now });
  }

  issueChallenge() {
    return this.challenges.issue();
  }

  beginPairing(request) {
    return this.ceremony.begin(request);
  }

  approvePairing(pairingId, { approvedBy = 'host-user', label } = {}) {
    return this.ceremony.approve(pairingId, { approvedBy, label });
  }

  denyPairing(pairingId) {
    this.ceremony.deny(pairingId);
  }

  handleConnect(request) {
    return authorizeConnection(
      { hostId: this.hostId, acl: this.acl, challenges: this.challenges, policy: this.policy },
      request,
    );
  }
}

/** A Client (Dormouse Pocket): one browser profile holding one device key. */
export class SimClient {
  static async create({ label = 'Test Client', origin } = {}) {
    const client = new SimClient({ label, origin });
    client.deviceKey = await generateDeviceKeyPair();
    return client;
  }

  constructor({ label, origin }) {
    this.label = label;
    this.origin = origin;
  }

  /** Simulate browser-data loss: the old key is gone, a fresh one replaces it. */
  async loseDeviceKey() {
    const previous = this.deviceKey.devicePublicKey;
    this.deviceKey = await generateDeviceKeyPair();
    return previous;
  }

  /** Run the pairing ceremony against a host; resolves to the ACL record. */
  async pair(host, { accountId, authenticator, approvedBy = 'host-user', label } = {}) {
    const ticket = host.beginPairing({
      accountId,
      passkeyCredentialId: authenticator.credentialId,
      passkeyPublicKeyHash: await hashPasskeyPublicKey(authenticator.publicKey),
      devicePublicKey: this.deviceKey.devicePublicKey,
      requestedLabel: this.label,
    });
    return host.approvePairing(ticket.pairingId, { approvedBy, label });
  }

  /**
   * Build the connection request a real client would send: fetch a Host
   * challenge, assert with the passkey over it, sign it with the device key.
   * `tamper.request` overrides request fields; `tamper.assertion` is passed
   * through to the authenticator.
   */
  async buildConnectRequest(host, { accountId, authenticator, tamper = {} }) {
    const { challenge } = host.issueChallenge();
    const assertion = await authenticator.assert({
      challenge,
      origin: this.origin,
      rpId: host.policy.rpId,
      tamper: tamper.assertion ?? {},
    });
    const deviceSignature = await signDeviceChallenge(this.deviceKey.privateKey, {
      hostId: tamper.signForHostId ?? host.hostId,
      challenge,
      devicePublicKey: this.deviceKey.devicePublicKey,
    });
    return {
      accountId,
      devicePublicKey: this.deviceKey.devicePublicKey,
      challenge,
      deviceSignature,
      passkey: { publicKey: authenticator.publicKey, assertion },
      ...(tamper.request ?? {}),
    };
  }

  /** Full connection flow: server account check, then the Host's decision. */
  async connect(host, { server, accountId, authenticator, tamper = {} }) {
    server.validateAccount(accountId, authenticator.credentialId);
    const request = await this.buildConnectRequest(host, { accountId, authenticator, tamper });
    return host.handleConnect(request);
  }
}

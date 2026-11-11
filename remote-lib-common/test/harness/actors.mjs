/**
 * Test-side identities for the remote-control suites: a WebAuthn passkey
 * (`SimAuthenticator`) faithful enough for the real presence verifier, the
 * routing-id and secret shapes of the wire, and a browser's registration
 * `clientDataJSON`. The Burrow's decisions are not modeled here: they are
 * pinned against the shipping `BurrowRuntime` in `lib`.
 */

import { concatBytes, ecdsaRawToDer, toBase64Url, utf8Encode } from '../../dist/index.js';

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

/**
 * Registration `clientDataJSON` exactly as a browser builds it for
 * `navigator.credentials.create()`, base64url, for `POST /api/setup/finish`.
 */
export function registrationClientData({ challenge, origin, type = 'webauthn.create' }) {
  return toBase64Url(utf8Encode(JSON.stringify({ type, challenge, origin, crossOrigin: false })));
}

/**
 * A passkey. WebAuthn is simulated faithfully enough to exercise the real
 * verifier: clientDataJSON, authenticatorData (rpIdHash/flags/signCount), and
 * a DER-encoded ES256 signature over `authData || sha256(clientDataJSON)`.
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

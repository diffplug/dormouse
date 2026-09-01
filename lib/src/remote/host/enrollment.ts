/**
 * Host enrollment and the legacy webview read path; `docs/specs/server.md` →
 * "Host side" owns the exchange and persistence contracts.
 */

import {
  API_ROUTES,
  NOISE_STATIC_PKCS8_MAX_LENGTH,
  NOISE_STATIC_PKCS8_MIN_LENGTH,
  fromBase64Url,
  mintNoiseStaticKeyPair,
  normalizeOrigin,
  type HostEnrollResponse,
} from 'server-lib-common';
import { loadJson, removeJson } from '../../lib/local-json-store';
import { HOST_REQUEST_TIMEOUT_MS } from './host-fetch';
import { ENROLLMENT_KEY } from './store';

export interface HostEnrollment {
  /** Origin the Server is reachable at, e.g. `https://dormouse.tailnet.ts.net`. */
  serverUrl: string;
  hostId: string;
  /** Bearer credential for the `token` query param of `/ws/host`. */
  hostToken: string;
  /** The Host's `ConnectionPolicy.origin`. */
  origin: string;
  /** The Host's `ConnectionPolicy.rpId`. */
  rpId: string;
  /**
   * The Host's `ConnectionPolicy.requireUserVerification`, mirrored from the
   * Server at enrollment so the two cannot disagree about what a valid
   * assertion is.
   *
   * Optional, and absent means `false`: an enrollment persisted by an older
   * build has no such field, and it must keep loading rather than being
   * rejected as malformed.
   */
  requireUserVerification?: boolean;
  /**
   * This Host's permanent Noise static, minted locally at enrollment: PKCS#8
   * of the X25519 private key, base64url.
   *
   * **The Server never receives it** — the enroll request body is unchanged —
   * and it lives only where the enrollment lives, which is owner-only storage
   * on both hosts (`SECURITY.md` → "Credentials at rest"). Optional today
   * because an enrollment persisted before this field existed must keep
   * loading; nothing reads it yet.
   */
  noiseStaticPrivateKey?: string;
  /** The raw 32-byte public half of that static, base64url. */
  noiseStaticPublicKey?: string;
}

/** Base64url of a raw 32-byte X25519 public key. */
const NOISE_STATIC_PUBLIC_KEY_LENGTH = 43;

/**
 * The shape guard, exported because everywhere an enrollment is *read* — a
 * keychain entry, a JSON file, an `adopt` a webview sent — it arrives as
 * `unknown` and has to be checked. One copy, so a field added here cannot be
 * silently accepted by a store that never learned about it.
 */
export function isEnrollment(value: unknown): value is HostEnrollment {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.serverUrl === 'string' &&
    typeof v.hostId === 'string' &&
    typeof v.hostToken === 'string' &&
    typeof v.origin === 'string' &&
    typeof v.rpId === 'string' &&
    // Optional — absent is the documented default. Present-but-wrong-typed is
    // still a rejection: a store that round-trips `"false"` as truthy would be
    // the silent disagreement this field exists to prevent.
    (v.requireUserVerification === undefined || typeof v.requireUserVerification === 'boolean') &&
    hasValidNoiseStatic(v)
  );
}

/**
 * **Both halves of the Noise static, or neither.** Absent is an enrollment
 * from before the field existed; one half alone is a truncated write or a
 * hand-edited file, and accepting it would leave a Host that believes it has
 * an identity it cannot use. Each present half is checked for a well-formed
 * base64url of the right decoded length, since this value goes straight to
 * `importKey` and the file is writable by anything running as the user.
 */
function hasValidNoiseStatic(v: Record<string, unknown>): boolean {
  const privateKey = v.noiseStaticPrivateKey;
  const publicKey = v.noiseStaticPublicKey;
  if (privateKey === undefined && publicKey === undefined) return true;
  if (typeof privateKey !== 'string' || typeof publicKey !== 'string') return false;
  if (publicKey.length !== NOISE_STATIC_PUBLIC_KEY_LENGTH) return false;
  let privateLength: number;
  try {
    if (fromBase64Url(publicKey).length !== 32) return false;
    privateLength = fromBase64Url(privateKey).length;
  } catch {
    return false;
  }
  return (
    privateLength >= NOISE_STATIC_PKCS8_MIN_LENGTH &&
    privateLength <= NOISE_STATIC_PKCS8_MAX_LENGTH
  );
}

export function getEnrollment(): HostEnrollment | null {
  // Missing key / malformed JSON / failed guard all collapse to `null`.
  return loadJson<HostEnrollment, null>(ENROLLMENT_KEY, null, isEnrollment);
}

export function clearEnrollment(): void {
  removeJson(ENROLLMENT_KEY);
}

/**
 * What proves this machine may enroll: the setup password the operator typed,
 * or the one-time token of an installer's offer for a Host on the server's own
 * machine (`lib/src/host/remote/enroll-offer.ts`). Exactly one — the wire type
 * `HostEnrollRequest` is the same union, and both or neither is a 400.
 */
export type HostEnrollCredential = { password: string } | { enrollToken: string };

/**
 * `POST /api/host/enroll` with one {@link HostEnrollCredential} and map the
 * response to an enrollment. Throws with the server's status text on failure —
 * or with what the response was missing when it answered 200 with something
 * that is not one — so the caller (console hook / settings UI) can surface it.
 * What this returns has passed {@link isEnrollment}, so the mint site and every
 * read agree on what an enrollment is.
 *
 * Persists nothing: the service that ran it decides where the credentials live
 * (`lib/src/host/remote/host-state-store.ts`), while the exchange itself is one
 * exchange, and a second copy of it could drift from the Server's contract.
 */
export async function performEnrollment(
  serverUrl: string,
  credential: HostEnrollCredential,
  label: string,
): Promise<HostEnrollment> {
  const base = serverUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}${API_ROUTES.hostEnroll}`, {
    method: 'POST',
    // The same budget every Host→Server call runs under (`host-fetch.ts`), and
    // this is the one that most needs it: it runs on the service's lifecycle
    // chain, where everything that starts or stops the Host queues behind it.
    signal: AbortSignal.timeout(HOST_REQUEST_TIMEOUT_MS),
    // The Node-resident Host has no browser CSP to check each redirect hop.
    // Failing here keeps an allowed origin's open redirect from forwarding the
    // credential — the setup password or the offer's one-time token, whichever
    // this body carries — to a server outside the build-time allowlist.
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    // Spread, so the body carries exactly the one credential the caller holds:
    // sending the other key as `undefined` would be dropped by `JSON.stringify`
    // anyway, but spelling it out keeps the "exactly one" the server enforces
    // visible at the only place that builds the request.
    body: JSON.stringify({ ...credential, label }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`host enroll failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  // The response body is untrusted like any other, so it goes through the same
  // guard every *read* of an enrollment uses. Without it a server that answers
  // 200 with a field missing — a version skew, a reverse proxy that rewrote the
  // body — mints an enrollment that is accepted here and rejected by
  // `isEnrollment` on the next read: the Host runs for this session with an
  // `undefined` in the `ConnectionPolicy` it authenticates passkeys against, and
  // the machine silently un-enrolls itself at the next launch with nothing in
  // the log to explain it. Failing the exchange instead keeps the old Host
  // running and names what the server got wrong.
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`host enroll failed: the server did not answer JSON (${errorMessage(error)})`);
  }
  const enrolled = body as Partial<HostEnrollResponse> | null;
  const enrollment = {
    serverUrl: base,
    hostId: enrolled?.hostId,
    hostToken: enrolled?.hostToken,
    // Untrusted like the rest of the body, and `isEnrollment` only checks that
    // it is a string — so it is reduced here, and anything that is not a URL
    // with a host fails the exchange below naming `origin`.
    origin: normalizeOrigin(enrolled?.origin) ?? undefined,
    rpId: enrolled?.rpId,
    // Only when the server actually sent a boolean: spreading `undefined` in
    // would make the key present-and-undefined, which the guard treats the
    // same but a store round-trip would not.
    ...(typeof enrolled?.requireUserVerification === 'boolean'
      ? { requireUserVerification: enrolled.requireUserVerification }
      : {}),
    // Minted here, after the Server answered, and never sent to it: the
    // request body above carries the credential and the label, nothing else.
    // Persisting it is the caller's job, alongside `hostToken`.
    ...(await mintNoiseStatic()),
  };
  if (!isEnrollment(enrollment)) {
    throw new Error(
      `host enroll failed: the server's response is missing or invalid: ${missingEnrollmentFields(enrollment).join(', ')}`,
    );
  }
  return enrollment;
}

/**
 * This Host's Noise static, or nothing.
 *
 * Best-effort on purpose: nothing consumes the static yet, so a runtime
 * without X25519 must still be able to enroll and run remote control exactly
 * as it does today. When the end-to-end protocol becomes mandatory, the
 * capability probe is what tells that runtime it cannot take part — an
 * enrollment that fails here with no explanation is not that message
 * (`docs/specs/remote-security-model.md`).
 */
async function mintNoiseStatic(): Promise<{
  noiseStaticPrivateKey?: string;
  noiseStaticPublicKey?: string;
}> {
  try {
    const material = await mintNoiseStaticKeyPair();
    return {
      noiseStaticPrivateKey: material.privateKeyPkcs8,
      noiseStaticPublicKey: material.publicKey,
    };
  } catch (error) {
    console.warn('[remote-host] could not mint the Noise static key', error);
    return {};
  }
}

/**
 * Which `HostEnrollResponse` fields the server left out or sent with the wrong
 * type, for the error above. The list mirrors {@link isEnrollment} minus
 * `serverUrl`, which is set locally and can never be the one at fault.
 */
function missingEnrollmentFields(enrollment: Record<string, unknown>): string[] {
  return (['hostId', 'hostToken', 'origin', 'rpId'] as const).filter(
    (field) => typeof enrollment[field] !== 'string',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

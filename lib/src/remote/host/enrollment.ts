/**
 * Host enrollment: the exchange, and the shape every store validates a record
 * against. `docs/specs/server.md` → "Host side" owns the persistence contract.
 */

import {
  API_ROUTES,
  BAD_PASSWORD_ERROR,
  UNAUTHORIZED_ERROR,
  isE2eId,
  isNoiseStaticMaterial,
  mintNoiseStaticKeyPair,
  normalizeOrigin,
  type HostEnrollResponse,
} from 'remote-lib-common';
import { HOST_REQUEST_TIMEOUT_MS } from './host-fetch';

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
   * What to call this machine — the "name for this machine" the operator typed
   * at enrollment.
   *
   * **Local only.** It is delivered to a Client inside the encrypted pairing and
   * connection outcomes and nowhere else; the Server never stores or sees it
   * past the enroll request. Optional because an enrollment persisted before
   * this field existed must keep loading rather than reading as un-enrolled.
   */
  label?: string;
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
   * on both hosts (`docs/specs/security-remote.md` → "Credentials at rest"). Optional today
   * because an enrollment persisted before this field existed must keep
   * loading; nothing reads it yet.
   */
  noiseStaticPrivateKey?: string;
  /** The raw 32-byte public half of that static, base64url. */
  noiseStaticPublicKey?: string;
}

/**
 * The shape guard, exported because everywhere an enrollment is *read* — a
 * keychain entry, a JSON file — it arrives as `unknown` and has to be checked.
 * One copy, so a field added here cannot be silently accepted by a store that
 * never learned about it.
 */
export function isEnrollment(value: unknown): value is HostEnrollment {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.serverUrl === 'string' &&
    // The shape, not merely the type: this `hostId` is the routing id of every
    // `e2e` envelope and the second field of every QR fragment, both of which
    // accept exactly `isE2eId`. A Server that answered another length — or a
    // hand-edited store — would otherwise leave this Host minting codes no
    // phone can parse, with nothing to explain it (`docs/specs/server.md` ->
    // State files, which pins the same shape at the mint).
    isE2eId(v.hostId) &&
    typeof v.hostToken === 'string' &&
    typeof v.origin === 'string' &&
    typeof v.rpId === 'string' &&
    (v.label === undefined || typeof v.label === 'string') &&
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
 * an identity it cannot use. What a well-formed half looks like is
 * `isNoiseStaticMaterial`'s to say — the value goes straight to `importKey`
 * from a file writable by anything running as this user.
 */
function hasValidNoiseStatic(v: Record<string, unknown>): boolean {
  const privateKey = v.noiseStaticPrivateKey;
  const publicKey = v.noiseStaticPublicKey;
  if (privateKey === undefined && publicKey === undefined) return true;
  if (typeof privateKey !== 'string' || typeof publicKey !== 'string') return false;
  return isNoiseStaticMaterial(publicKey, privateKey);
}

/**
 * What proves this machine may enroll: the setup password the operator typed,
 * or the one-time token of an installer's offer for a Host on the server's own
 * machine (`lib/src/host/remote/enroll-offer.ts`). Exactly one — the wire type
 * `HostEnrollRequest` is the same union, and both or neither is a 400.
 */
export type HostEnrollCredential = { password: string } | { enrollToken: string };

/**
 * How much of a refusal's body is worth showing. A 502 from a reverse proxy is
 * a whole HTML document, and the settings dialog's error slot is one sentence.
 */
const REFUSAL_DETAIL_LIMIT = 120;

/** The refusal's first line, bounded — never the whole body (see the limit). */
function boundedDetail(detail: string): string {
  const line = detail.split('\n', 1)[0]!.trim();
  return line.length > REFUSAL_DETAIL_LIMIT ? `${line.slice(0, REFUSAL_DETAIL_LIMIT)}…` : line;
}

/**
 * What the settings form shows for a refused enrollment.
 *
 * **The 401 splits on which credential the Server says it refused**, because
 * only one of them is something the person at the laptop can retype: a rejected
 * password is a typo, while a rejected offer token means the installer's
 * one-time offer is spent or was rewritten, and no amount of retrying that
 * button will help. The Server names which in the body — the two strings are
 * shared for exactly this — so a 401 raised by anything in front of it falls
 * through to the generic message rather than confidently sending the user to
 * retype a password that was fine.
 *
 * Every other status keeps the number and the server's own text: there is no
 * user action to name, and an operator debugging a reverse proxy needs both.
 */
function refusalMessage(status: number, detail: string): string {
  if (status === 401) {
    const error = refusedError(detail);
    if (error === BAD_PASSWORD_ERROR) return 'The server did not accept that setup password.';
    if (error === UNAUTHORIZED_ERROR) {
      return 'This machine’s enrollment offer is no longer valid. Enroll with the server address and setup password instead.';
    }
  }
  const shown = boundedDetail(detail);
  return `The server refused the enrollment (HTTP ${status})${shown ? `: ${shown}` : ''}`;
}

/** The `error` a JSON refusal names, or `null` for a body that is not one. */
function refusedError(detail: string): string | null {
  try {
    const error = (JSON.parse(detail) as { error?: unknown } | null)?.error;
    return typeof error === 'string' ? error : null;
  } catch {
    return null;
  }
}

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
  // Minted BEFORE the exchange. A successful POST appends a `hosts.json` row
  // and spends the installer's single-use `enrollToken`, neither of which this
  // side can undo — so a runtime that cannot produce an X25519 key must fail
  // while the Server still has nothing to forget. Nothing about it reaches the
  // request body below.
  const noiseStatic = await mintNoiseStatic();
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
    // The credential and nothing else — in particular no `label`, which stays
    // local (`docs/specs/remote-security-model.md` -> Host identity).
    body: JSON.stringify(credential),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(refusalMessage(response.status, detail));
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
    throw new Error(`Could not enroll: the server did not answer JSON (${errorMessage(error)})`);
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
    // Never sent, never returned: the operator's answer, kept here.
    label,
    // Only when the server actually sent a boolean: spreading `undefined` in
    // would make the key present-and-undefined, which the guard treats the
    // same but a store round-trip would not.
    ...(typeof enrolled?.requireUserVerification === 'boolean'
      ? { requireUserVerification: enrolled.requireUserVerification }
      : {}),
    // Minted above and never sent to the Server. Persisting it is the caller's
    // job, alongside `hostToken`.
    ...noiseStatic,
  };
  if (!isEnrollment(enrollment)) {
    throw new Error(
      `Could not enroll: the server's answer is missing or invalid: ${missingEnrollmentFields(enrollment).join(', ')}`,
    );
  }
  return enrollment;
}

/**
 * This Host's Noise static. **A runtime that cannot mint one does not enroll.**
 *
 * The end-to-end protocol is mandatory and the static is the Host's identity in
 * it, so an enrollment without one would persist a `hostToken` for a machine
 * that can never answer a pairing or a connection. Failing the exchange here is
 * the probe gate's Host half: the message names the missing capability rather
 * than leaving the operator with a Host that enrolled and then does nothing
 * (`docs/specs/remote-security-model.md` → Noise suite).
 */
async function mintNoiseStatic(): Promise<{
  noiseStaticPrivateKey: string;
  noiseStaticPublicKey: string;
}> {
  let material;
  try {
    material = await mintNoiseStaticKeyPair();
  } catch (error) {
    throw new Error(
      `Could not enroll: this build cannot generate the X25519 key remote control requires (${errorMessage(error)})`,
    );
  }
  // Checked against the guard the enrollment must pass, so a runtime whose
  // PKCS#8 falls outside what `isEnrollment` accepts fails here — naming the
  // key — rather than at the next read, naming nothing.
  if (!isNoiseStaticMaterial(material.publicKey, material.privateKeyPkcs8)) {
    throw new Error('Could not enroll: the minted X25519 key is not a shape this build persists');
  }
  return {
    noiseStaticPrivateKey: material.privateKeyPkcs8,
    noiseStaticPublicKey: material.publicKey,
  };
}

/**
 * Which `HostEnrollResponse` fields the server left out or sent wrong, for the
 * error above. Mirrors {@link isEnrollment} minus `serverUrl`, which is set
 * locally and can never be the one at fault — including its *shape* checks, so
 * a rejection can never name nothing. Pinned by `enrollment.test.ts`.
 */
function missingEnrollmentFields(enrollment: Record<string, unknown>): string[] {
  const wrong = (['hostId', 'hostToken', 'origin', 'rpId'] as const).filter(
    (field) => typeof enrollment[field] !== 'string',
  );
  if (!wrong.includes('hostId') && !isE2eId(enrollment.hostId)) wrong.unshift('hostId');
  return wrong;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Burrow enrollment: the exchange, and the shape every store validates a record
 * against. `docs/specs/relay.md` → "Burrow side" owns the persistence contract.
 */

import {
  API_ROUTES,
  BAD_PASSWORD_ERROR,
  NOT_ENTITLED_ERROR,
  ORIGIN_MISMATCH_ERROR,
  UNAUTHORIZED_ERROR,
  isBurrowEnrollBeginResponse,
  isBurrowEnrollPollResponse,
  isE2eId,
  isManagedVoiceToken,
  isNoiseStaticMaterial,
  mintNoiseStaticKeyPair,
  normalizeOrigin,
  type BurrowEnrollBeginRequest,
  type BurrowEnrollBeginResponse,
  type BurrowEnrollPollRequest,
  type BurrowEnrollRequest,
  type BurrowEnrollResponse,
} from 'remote-lib-common';
import { BURROW_REQUEST_TIMEOUT_MS } from './burrow-fetch';

export interface BurrowEnrollment {
  /**
   * Origin the Relay is reachable at, e.g. `https://dormouse.tailnet.ts.net`:
   * the build's baked relay origin at enrollment. A build baked with any other
   * reads this enrollment as none (`docs/specs/relay.md` → "Relay origin").
   */
  relayUrl: string;
  burrowId: string;
  /** Bearer credential for the `token` query param of `/ws/burrow`. */
  burrowToken: string;
  /** The Burrow's `ConnectionPolicy.origin`. */
  origin: string;
  /** The Burrow's `ConnectionPolicy.rpId`. */
  rpId: string;
  /**
   * What to call this machine — the "name for this machine" the operator typed
   * at enrollment.
   *
   * **Local only.** It is delivered to a Client inside the encrypted pairing and
   * connection outcomes and nowhere else; the Relay never stores or sees it
   * in an enrollment request.
   */
  label: string;
  /**
   * The Burrow's `ConnectionPolicy.requireUserVerification`, mirrored from the
   * Relay at enrollment so the two cannot disagree about what a valid
   * assertion is.
   *
   * Optional, and absent means `false`: it is persisted only when the Relay
   * sent it.
   */
  requireUserVerification?: boolean;
  /**
   * This Burrow's permanent Noise static, minted locally at enrollment: PKCS#8
   * of the X25519 private key, base64url.
   *
   * **The Relay never receives it** — the enroll request body is unchanged —
   * and it lives only where the enrollment lives, which is owner-only storage
   * on both burrows (`docs/specs/security-remote.md` → "Credentials at rest").
   */
  noiseStaticPrivateKey: string;
  /** The raw 32-byte public half of that static, base64url. */
  noiseStaticPublicKey: string;
}

/**
 * The shape guard, exported because everywhere an enrollment is *read* — a
 * keychain entry, a JSON file — it arrives as `unknown` and has to be checked.
 * One copy, so a field added here cannot be silently accepted by a store that
 * never learned about it.
 */
export function isEnrollment(value: unknown): value is BurrowEnrollment {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.relayUrl === 'string' &&
    // The shape, not merely the type: this `burrowId` is the routing id of every
    // `e2e` envelope and the second field of every QR fragment, both of which
    // accept exactly `isE2eId`. A Relay that answered another length — or a
    // hand-edited store — would otherwise leave this Burrow minting codes no
    // phone can parse, with nothing to explain it (`docs/specs/relay.md` ->
    // State files, which pins the same shape at the mint).
    isE2eId(v.burrowId) &&
    typeof v.burrowToken === 'string' &&
    typeof v.origin === 'string' &&
    typeof v.rpId === 'string' &&
    // Non-blank: phones show it as this Burrow's name.
    typeof v.label === 'string' &&
    v.label.trim() !== '' &&
    // Optional — absent is the documented default. Present-but-wrong-typed is
    // still a rejection: a store that round-trips `"false"` as truthy would be
    // the silent disagreement this field exists to prevent.
    (v.requireUserVerification === undefined || typeof v.requireUserVerification === 'boolean') &&
    hasValidNoiseStatic(v)
  );
}

/**
 * **Both halves of the Noise static, well-formed.** A missing half is a
 * truncated write or a hand-edited file, and accepting it would leave a Burrow
 * that believes it has an identity it cannot use. What a well-formed half looks
 * like is `isNoiseStaticMaterial`'s to say — the value goes straight to
 * `importKey` from a file writable by anything running as this user.
 */
function hasValidNoiseStatic(v: Record<string, unknown>): boolean {
  const privateKey = v.noiseStaticPrivateKey;
  const publicKey = v.noiseStaticPublicKey;
  if (typeof privateKey !== 'string' || typeof publicKey !== 'string') return false;
  return isNoiseStaticMaterial(publicKey, privateKey);
}

/**
 * What proves this machine may enroll: the setup password the operator typed,
 * or the one-time token of an installer's offer for a Burrow on the Relay's own
 * machine (`lib/src/host/remote/enroll-offer.ts`). Exactly one — the wire type
 * `BurrowEnrollRequest` is the same union, and both or neither is a 400.
 */
export type BurrowEnrollCredential = { password: string } | { enrollToken: string };

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
 * **The 401 splits on which credential the Relay says it refused**, because
 * only one of them is something the person at the laptop can retype: a rejected
 * password is a typo, while a rejected offer token means the installer's
 * one-time offer is spent or was rewritten, and no amount of retrying that
 * button will help. The Relay names which in the body — the two strings are
 * shared for exactly this — so a 401 raised by anything in front of it falls
 * through to the generic message rather than confidently sending the user to
 * retype a password that was fine.
 *
 * A 409 naming another origin is a build made for another Relay, and says how
 * to line the two up ({@link originMismatchMessage}).
 *
 * Every other status keeps the number and the Relay's own text: there is no
 * user action to name, and an operator debugging a reverse proxy needs both.
 */
function refusalMessage(status: number, detail: string, relayOrigin: string): string {
  if (status === 409) {
    const body = refusedBody(detail);
    const reported = body?.error === ORIGIN_MISMATCH_ERROR ? normalizeOrigin(body.origin) : null;
    if (reported) return originMismatchMessage(reported, relayOrigin);
  }
  if (status === 401) {
    const error = refusedError(detail);
    if (error === BAD_PASSWORD_ERROR) return 'The Relay did not accept that setup password.';
    if (error === UNAUTHORIZED_ERROR) {
      return 'This machine’s enrollment offer is no longer valid. Enroll with the setup password instead.';
    }
  }
  const shown = boundedDetail(detail);
  return `The Relay refused the enrollment (HTTP ${status})${shown ? `: ${shown}` : ''}`;
}

/** A JSON refusal's body, or `null` for one that is not an object. */
function refusedBody(detail: string): Record<string, unknown> | null {
  try {
    const body: unknown = JSON.parse(detail);
    return body && typeof body === 'object' ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The `error` a JSON refusal names, or `null` for a body that is not one. */
function refusedError(detail: string): string | null {
  const error = refusedBody(detail)?.error;
  return typeof error === 'string' ? error : null;
}

/**
 * What a Relay served from `reported` tells a Burrow built for `relayOrigin`:
 * both, and the two ways to make them agree (`docs/specs/relay.md` → "Relay
 * origin").
 */
export function originMismatchMessage(reported: string, relayOrigin: string): string {
  return (
    `The Relay says its origin is ${reported}, but this build was made for ${relayOrigin}. ` +
    `Rebuild Dormouse with DORMOUSE_RELAY_ORIGIN=${reported}, or set the Relay's ` +
    `DORMOUSE_ORIGIN to ${relayOrigin}.`
  );
}

/**
 * `POST /api/burrow/enroll` with one {@link BurrowEnrollCredential} and map the
 * response to an enrollment. Throws with the Relay's status text on failure —
 * or with what the response was missing when it answered 200 with something
 * that is not one — so the caller (console hook / settings UI) can surface it.
 * What this returns has passed {@link isEnrollment}, so the mint site and every
 * read agree on what an enrollment is.
 *
 * Persists nothing: the service that ran it decides where the credentials live
 * (`lib/src/host/remote/burrow-state-store.ts`), while the exchange itself is one
 * exchange, and a second copy of it could drift from the Relay's contract.
 */
export async function performEnrollment(
  relayOrigin: string,
  credential: BurrowEnrollCredential,
  label: string,
  // The service's own, which the network policy guards
  // (`lib/src/host/remote/service.ts`); no default, so no caller goes around it.
  fetch: typeof globalThis.fetch,
): Promise<BurrowEnrollment> {
  // Minted BEFORE the exchange. A successful POST appends a `burrows.json` row
  // and spends the installer's single-use `enrollToken`, neither of which this
  // side can undo — so a runtime that cannot produce an X25519 key must fail
  // while the Relay still has nothing to forget. Nothing about it reaches the
  // request body below.
  const noiseStatic = await mintNoiseStatic();
  const response = await fetch(`${relayOrigin}${API_ROUTES.burrowEnroll}`, {
    method: 'POST',
    // The same budget every Burrow→Relay call runs under (`burrow-fetch.ts`), and
    // this is the one that most needs it: it runs on the service's lifecycle
    // chain, where everything that starts or stops the Burrow queues behind it.
    signal: AbortSignal.timeout(BURROW_REQUEST_TIMEOUT_MS),
    // The Node-resident Burrow has no browser CSP to check each redirect hop.
    // Failing here keeps the Relay's open redirect from forwarding the
    // credential — the setup password or the offer's one-time token, whichever
    // this body carries — to an origin the build was never baked with.
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    // The credential and the baked origin, which a Relay served from another
    // refuses before saving anything, and nothing else — in particular no
    // `label`, which stays local (`docs/specs/remote-security-model.md` ->
    // Burrow identity).
    body: JSON.stringify({ ...credential, origin: relayOrigin } satisfies BurrowEnrollRequest),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(refusalMessage(response.status, detail, relayOrigin));
  }
  // The response body is untrusted like any other, so it goes through the same
  // guard every *read* of an enrollment uses. Without it a Relay that answers
  // 200 with a field missing — a version skew, a reverse proxy that rewrote the
  // body — mints an enrollment that is accepted here and rejected by
  // `isEnrollment` on the next read: the Burrow runs for this session with an
  // `undefined` in the `ConnectionPolicy` it authenticates passkeys against, and
  // the machine silently un-enrolls itself at the next launch with nothing in
  // the log to explain it. Failing the exchange instead keeps the old Burrow
  // running and names what the Relay got wrong.
  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    throw new Error(`Could not enroll: the Relay did not answer JSON (${errorMessage(error)})`);
  }
  return enrollmentFrom(relayOrigin, body, label, noiseStatic);
}

/**
 * A Relay's {@link BurrowEnrollResponse} as this Burrow's enrollment, or a
 * throw naming what it got wrong: one mapping for both exchanges, so the
 * password and the device code mint the same shape through {@link isEnrollment}.
 */
function enrollmentFrom(
  relayOrigin: string,
  body: unknown,
  label: string,
  noiseStatic: EnrollmentStatic,
): BurrowEnrollment {
  const enrolled = body as Partial<BurrowEnrollResponse> | null;
  const enrollment = {
    relayUrl: relayOrigin,
    burrowId: enrolled?.burrowId,
    burrowToken: enrolled?.burrowToken,
    // Untrusted like the rest of the body, and `isEnrollment` only checks that
    // it is a string — so it is reduced here, and anything that is not a URL
    // with a burrow fails the exchange below naming `origin`.
    origin: normalizeOrigin(enrolled?.origin) ?? undefined,
    rpId: enrolled?.rpId,
    // Never sent, never returned: the operator's answer, kept here.
    label,
    // Only when the Relay actually sent a boolean: spreading `undefined` in
    // would make the key present-and-undefined, which the guard treats the
    // same but a store round-trip would not.
    ...(typeof enrolled?.requireUserVerification === 'boolean'
      ? { requireUserVerification: enrolled.requireUserVerification }
      : {}),
    // Minted before the first request and never sent to the Relay. Persisting
    // it is the caller's job, alongside `burrowToken`.
    ...noiseStatic,
  };
  if (!isEnrollment(enrollment)) {
    throw new Error(
      `Could not enroll: the Relay's answer is missing or invalid: ${missingEnrollmentFields(enrollment).join(', ')}`,
    );
  }
  return enrollment;
}

// --- Hosted's device code (`docs/specs/hosted.md` -> "Burrow enrollment") ---

/** A begun device-code enrollment: the Relay's checked answer, and the static minted before it. */
export interface HostedEnrollmentBegun {
  begin: BurrowEnrollBeginResponse;
  noiseStatic: EnrollmentStatic;
}

/**
 * `POST /api/burrow/enroll/begin` with the baked origin, the answer checked by
 * `isBurrowEnrollBeginResponse`. Throws what the settings panel shows. The
 * Noise static is minted first, as {@link performEnrollment} mints it, so a
 * runtime that cannot make one fails before the Relay is asked anything; the
 * caller holds it until a poll redeems, and the Relay never sees it.
 */
export async function beginHostedEnrollment(
  relayOrigin: string,
  // The service's guarded fetch, as for `performEnrollment`; no default.
  fetch: typeof globalThis.fetch,
): Promise<HostedEnrollmentBegun> {
  const noiseStatic = await mintNoiseStatic();
  const response = await fetch(`${relayOrigin}${API_ROUTES.burrowEnrollBegin}`, {
    method: 'POST',
    signal: AbortSignal.timeout(BURROW_REQUEST_TIMEOUT_MS),
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ origin: relayOrigin } satisfies BurrowEnrollBeginRequest),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(refusalMessage(response.status, detail, relayOrigin));
  }
  const body: unknown = await response.json().catch(() => null);
  if (!isBurrowEnrollBeginResponse(body)) {
    throw new Error('Could not enroll: the Relay’s answer was not an enrollment code.');
  }
  return { begin: body, noiseStatic };
}

/**
 * What one poll says. `enrolled` carries the managed-voice token the Relay
 * minted with the Burrow, or `null` where it sent none of a token's shape.
 * `retry` is a poll that told nothing — the Relay
 * unreachable, a 5xx, a 2xx whose body was lost mid-read, or a 429, which asks
 * the Burrow to `slowDown` — and the
 * next poll asks again; `redeemed` is an approval an earlier poll spent on
 * `burrowId`, whose answer never arrived; `refused` keeps the copy for its fixed reasons to the
 * panel; `failed` names what went wrong.
 */
export type HostedEnrollmentPoll =
  | { status: 'pending' }
  | { status: 'retry'; slowDown: boolean }
  | { status: 'expired' }
  | { status: 'redeemed'; burrowId: string }
  | { status: 'enrolled'; enrollment: BurrowEnrollment; voiceToken: string | null }
  | { status: 'refused'; reason: 'not-entitled' | 'account-full' }
  | { status: 'failed'; message: string };

/**
 * `POST /api/burrow/enroll/poll` once. **Never throws**: the service's poll
 * loop reads every outcome. An `enrolled` answer is mapped through the same
 * {@link isEnrollment} guard as the password exchange's, with `label` and the
 * static {@link beginHostedEnrollment} minted.
 */
export async function pollHostedEnrollment(
  relayOrigin: string,
  deviceCode: string,
  label: string,
  noiseStatic: EnrollmentStatic,
  fetch: typeof globalThis.fetch,
): Promise<HostedEnrollmentPoll> {
  let response: Response;
  try {
    response = await fetch(`${relayOrigin}${API_ROUTES.burrowEnrollPoll}`, {
      method: 'POST',
      signal: AbortSignal.timeout(BURROW_REQUEST_TIMEOUT_MS),
      // The device code is a bearer until it expires.
      redirect: 'error',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ deviceCode } satisfies BurrowEnrollPollRequest),
    });
  } catch {
    return { status: 'retry', slowDown: false };
  }
  if (response.status === 429) return { status: 'retry', slowDown: true };
  if (response.status >= 500) return { status: 'retry', slowDown: false };
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    if (response.status === 403 && refusedError(detail) === NOT_ENTITLED_ERROR) {
      return { status: 'refused', reason: 'not-entitled' };
    }
    // The poll's only 409: the account holds `MAX_ENROLLED_BURROWS` already.
    if (response.status === 409) return { status: 'refused', reason: 'account-full' };
    return { status: 'failed', message: refusalMessage(response.status, detail, relayOrigin) };
  }
  // A body lost on the wire after a 2xx's headers is a transport failure like
  // one before them: the next poll can still hear `redeemed`. Only a complete
  // body that is not an enrollment poll fails.
  let text: string;
  try {
    text = await response.text();
  } catch {
    return { status: 'retry', slowDown: false };
  }
  const body = parseJson(text);
  if (!isBurrowEnrollPollResponse(body)) {
    return { status: 'failed', message: 'Could not enroll: the Relay’s answer was not an enrollment poll.' };
  }
  // Rebuilt, so nothing but the guarded fields reaches `status`.
  if (body.status === 'redeemed') return { status: 'redeemed', burrowId: body.burrowId };
  if (body.status !== 'enrolled') return { status: body.status };
  try {
    return {
      status: 'enrolled',
      enrollment: enrollmentFrom(relayOrigin, body.enrollment, label, noiseStatic),
      // The signed-in desktop's managed voice; one of the wrong shape is
      // dropped rather than failing an approval the Relay already spent.
      voiceToken: isManagedVoiceToken(body.voiceToken) ? body.voiceToken : null,
    };
  } catch (error) {
    return { status: 'failed', message: errorMessage(error) };
  }
}

/** The Noise static an enrollment carries, minted before its first request. */
export interface EnrollmentStatic {
  noiseStaticPrivateKey: string;
  noiseStaticPublicKey: string;
}

/**
 * This Burrow's Noise static. **A runtime that cannot mint one does not enroll.**
 *
 * The end-to-end protocol is mandatory and the static is the Burrow's identity in
 * it, so an enrollment without one would persist a `burrowToken` for a machine
 * that can never answer a pairing or a connection. Failing the exchange here is
 * the probe gate's Burrow half: the message names the missing capability rather
 * than leaving the operator with a Burrow that enrolled and then does nothing
 * (`docs/specs/remote-security-model.md` → Noise suite).
 */
async function mintNoiseStatic(): Promise<EnrollmentStatic> {
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
 * Which `BurrowEnrollResponse` fields the Relay left out or sent wrong, for the
 * error above. Mirrors {@link isEnrollment} minus `relayUrl`, which is set
 * locally and can never be the one at fault — including its *shape* checks, so
 * a rejection can never name nothing. Pinned by `enrollment.test.ts`.
 */
function missingEnrollmentFields(enrollment: Record<string, unknown>): string[] {
  const wrong = (['burrowId', 'burrowToken', 'origin', 'rpId'] as const).filter(
    (field) => typeof enrollment[field] !== 'string',
  );
  if (!wrong.includes('burrowId') && !isE2eId(enrollment.burrowId)) wrong.unshift('burrowId');
  return wrong;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

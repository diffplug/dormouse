/**
 * Host enrollment and the legacy webview read path; `docs/specs/server.md` →
 * "Host side" owns the exchange and persistence contracts.
 */

import { API_ROUTES, type HostEnrollResponse } from 'server-lib-common';
import { loadJson, removeJson } from '../../lib/local-json-store';
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
}

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
    (v.requireUserVerification === undefined || typeof v.requireUserVerification === 'boolean')
  );
}

export function getEnrollment(): HostEnrollment | null {
  // Missing key / malformed JSON / failed guard all collapse to `null`.
  return loadJson<HostEnrollment, null>(ENROLLMENT_KEY, null, isEnrollment);
}

export function clearEnrollment(): void {
  removeJson(ENROLLMENT_KEY);
}

const ENROLL_TIMEOUT_MS = 10_000;

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
    // This runs on the Host service's lifecycle chain, where everything that
    // starts or stops the Host queues behind it — so a relay that accepts the
    // connection and then answers nothing would wedge every later command for
    // as long as the platform's default socket timeout, which is minutes. Below
    // the webview's own 15 s command budget (`link-client.ts`) on purpose: the
    // console then sees "the server did not answer" rather than a bare timeout.
    signal: AbortSignal.timeout(ENROLL_TIMEOUT_MS),
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
    origin: enrolled?.origin,
    rpId: enrolled?.rpId,
    // Only when the server actually sent a boolean: spreading `undefined` in
    // would make the key present-and-undefined, which the guard treats the
    // same but a store round-trip would not.
    ...(typeof enrolled?.requireUserVerification === 'boolean'
      ? { requireUserVerification: enrolled.requireUserVerification }
      : {}),
  };
  if (!isEnrollment(enrollment)) {
    throw new Error(
      `host enroll failed: the server's response is missing or invalid: ${missingEnrollmentFields(enrollment).join(', ')}`,
    );
  }
  return enrollment;
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

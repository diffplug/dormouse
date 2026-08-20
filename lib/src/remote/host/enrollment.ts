/**
 * Host enrollment against the selfhost Server (docs/specs/server.md → "Host
 * side"). Enrollment is the one-time exchange that turns a setup password into
 * the durable credentials the Host needs to hold its `/ws/host` socket:
 * `{ serverUrl, hostId, hostToken, origin, rpId }`. `origin`/`rpId` become the
 * Host's `ConnectionPolicy` — the Server tells the Host what it must enforce,
 * and the Host enforces it as final authority regardless.
 *
 * The Host that holds the socket is a service in the process that owns the
 * PTYs, and it persists this through its own store (a 0600 file in the sidecar,
 * `SecretStorage` in VS Code — `lib/src/host/remote/host-state-store.ts`).
 * What is left here of the browser's `localStorage` copy is the read path: a
 * webview that enrolled before the service existed still has one, and hands it
 * over once (`activation.ts` → adoption).
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
    typeof v.rpId === 'string'
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
 * `POST /api/host/enroll` with the setup password and map the response to an
 * enrollment. Throws with the server's status text on failure — or with what the
 * response was missing when it answered 200 with something that is not one — so
 * the caller (console hook / settings UI) can surface it. What this returns has
 * passed {@link isEnrollment}, so the mint site and every read agree on what an
 * enrollment is.
 *
 * Persists nothing: the service that ran it decides where the credentials live
 * (`lib/src/host/remote/host-state-store.ts`), while the exchange itself is one
 * exchange, and a second copy of it could drift from the Server's contract.
 */
export async function performEnrollment(
  serverUrl: string,
  password: string,
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
    // setup password to a server outside the build-time allowlist.
    redirect: 'error',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, label }),
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

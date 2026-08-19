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

/**
 * `POST /api/host/enroll` with the setup password and map the response to an
 * enrollment. Throws with the server's status text on failure so the caller
 * (console hook / settings UI) can surface it.
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
  const body = (await response.json()) as HostEnrollResponse;
  return {
    serverUrl: base,
    hostId: body.hostId,
    hostToken: body.hostToken,
    origin: body.origin,
    rpId: body.rpId,
  };
}

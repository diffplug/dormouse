/**
 * Host enrollment against the selfhost Server (docs/specs/server.md → "Host
 * side"). Enrollment is the one-time exchange that turns a setup password into
 * the durable credentials the Host needs to hold its `/ws/host` socket:
 * `{ serverUrl, hostId, hostToken, origin, rpId }`. `origin`/`rpId` become the
 * Host's `ConnectionPolicy` — the Server tells the Host what it must enforce,
 * and the Host enforces it as final authority regardless.
 *
 * Persisted in `localStorage` (browser-only, no platform adapter dependency) so
 * the standalone app can rehydrate and reconnect on the next launch.
 */

import { API_ROUTES, type HostEnrollResponse } from 'server-lib-common';

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

/** Single localStorage key holding the whole enrollment blob. */
export const ENROLLMENT_KEY = 'dormouse.remote-host.enrollment';

function isEnrollment(value: unknown): value is HostEnrollment {
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
  try {
    const raw = globalThis.localStorage?.getItem(ENROLLMENT_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isEnrollment(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function clearEnrollment(): void {
  try {
    globalThis.localStorage?.removeItem(ENROLLMENT_KEY);
  } catch {
    // No localStorage (some host/test contexts): nothing to clear.
  }
}

function saveEnrollment(enrollment: HostEnrollment): void {
  try {
    globalThis.localStorage?.setItem(ENROLLMENT_KEY, JSON.stringify(enrollment));
  } catch {
    // No localStorage: the caller still gets the in-memory enrollment back.
  }
}

/**
 * `POST /api/host/enroll` with the setup password, persist the returned
 * credentials, and hand the enrollment back. Throws with the server's status
 * text on failure so the caller (console hook / settings UI) can surface it.
 */
export async function enrollHost(
  serverUrl: string,
  password: string,
  label: string,
): Promise<HostEnrollment> {
  const base = serverUrl.replace(/\/+$/, '');
  const response = await fetch(`${base}${API_ROUTES.hostEnroll}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ password, label }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw new Error(`host enroll failed (${response.status})${detail ? `: ${detail}` : ''}`);
  }
  const body = (await response.json()) as HostEnrollResponse;
  const enrollment: HostEnrollment = {
    serverUrl: base,
    hostId: body.hostId,
    hostToken: body.hostToken,
    origin: body.origin,
    rpId: body.rpId,
  };
  saveEnrollment(enrollment);
  return enrollment;
}

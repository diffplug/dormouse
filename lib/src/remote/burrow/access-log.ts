/**
 * The access log: what reached this machine's terminals, for the person who
 * owns it (`docs/specs/remote-security-model.md` -> "Access log"). Owner-local,
 * append-only, and bounded. **Never terminal content**: an entry names a
 * device, an event, a time, and at most a surface id, a path, a duration, and
 * why a request was refused.
 *
 * Shared by the runtime that observes, the service that keeps and persists,
 * and the webview and `dor` that read.
 */

import { fromBase64Url } from 'remote-lib-common';

/** Entries kept; the oldest goes when one more arrives. */
export const ACCESS_LOG_MAX_ENTRIES = 500;

/** The longest `reason` or `surface` an entry keeps, so a hand-edited file stays bounded too. */
const MAX_FIELD_LENGTH = 128;

/** What happened, one word each. `one-time-*` are the one-time connection's, which has no device id. */
export const ACCESS_EVENTS = [
  'paired',
  'pairing-denied',
  'connected',
  'connection-denied',
  'attached',
  'ended',
  'revoked',
  'one-time-connected',
  'one-time-denied',
  'one-time-ended',
] as const;
export type AccessEvent = (typeof ACCESS_EVENTS)[number];

export interface AccessLogEntry {
  /** Epoch ms, this machine's clock. */
  at: number;
  event: AccessEvent;
  /** The device's label as this Burrow mapped it: a member of a closed set, never text the phone chose. */
  device: string;
  /** {@link deviceIdFor} of the IK-authenticated Client static; absent for a one-time phone. */
  deviceId?: string;
  /** Which carrier a session ended on: `direct` once it switched, else `relayed`. */
  path?: 'relayed' | 'direct';
  /** How a connection proved presence: a fresh proof, or the presence window this Burrow opened. */
  presence?: 'proof' | 'window';
  /** How long the session lasted, for `ended` and `one-time-ended`. */
  durationMs?: number;
  /** Why a request was refused, specifically: the ACL miss or presence failure the wire never carries. */
  reason?: string;
  /** The surface an `attached` entry attached. */
  surface?: string;
  /** Who asked for a `revoked`: a member of `REVOCATION_REQUESTERS` (`acl.ts`). */
  by?: string;
}

/** Bytes of the Client static a device id keeps: 64 bits, so no paired phone can grind another's. */
const DEVICE_ID_BYTES = 8;

/**
 * The short, stable name `dor` and the Settings list use for one paired
 * browser: the first {@link DEVICE_ID_BYTES} bytes of its Client static, in
 * hex, so it never starts with a `-` a command line would read as a flag. A
 * public key carries no authority, so neither does this; the service refuses a
 * revoke an id matches more than one Client static for.
 */
export function deviceIdFor(clientStaticPublicKey: string): string {
  let bytes: Uint8Array;
  try {
    bytes = fromBase64Url(clientStaticPublicKey);
  } catch {
    return '';
  }
  return Array.from(bytes.subarray(0, DEVICE_ID_BYTES), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

/** `entries` with `entry` appended and the oldest dropped past the bound; never mutates `entries`. */
export function appendAccessLog(entries: readonly AccessLogEntry[], entry: AccessLogEntry): AccessLogEntry[] {
  const next = [...entries, entry];
  return next.length > ACCESS_LOG_MAX_ENTRIES ? next.slice(next.length - ACCESS_LOG_MAX_ENTRIES) : next;
}

function boundedString(value: unknown): string | undefined {
  return typeof value === 'string' ? value.slice(0, MAX_FIELD_LENGTH) : undefined;
}

/**
 * One entry off disk or off the bridge, rebuilt field by field, or `null` for
 * anything that is not one. A field this build does not know is dropped.
 */
export function parseAccessLogEntry(value: unknown): AccessLogEntry | null {
  if (!value || typeof value !== 'object') return null;
  const raw = value as Record<string, unknown>;
  if (typeof raw.at !== 'number' || !Number.isFinite(raw.at)) return null;
  const event = ACCESS_EVENTS.find((known) => known === raw.event);
  const device = boundedString(raw.device);
  if (!event || device === undefined) return null;
  const entry: AccessLogEntry = { at: raw.at, event, device };
  const deviceId = boundedString(raw.deviceId);
  if (deviceId !== undefined) entry.deviceId = deviceId;
  if (raw.path === 'relayed' || raw.path === 'direct') entry.path = raw.path;
  if (raw.presence === 'proof' || raw.presence === 'window') entry.presence = raw.presence;
  if (typeof raw.durationMs === 'number' && Number.isFinite(raw.durationMs)) entry.durationMs = raw.durationMs;
  const reason = boundedString(raw.reason);
  if (reason !== undefined) entry.reason = reason;
  const surface = boundedString(raw.surface);
  if (surface !== undefined) entry.surface = surface;
  const by = boundedString(raw.by);
  if (by !== undefined) entry.by = by;
  return entry;
}

/** A stored log, oldest first: what is not an entry is dropped, and the newest {@link ACCESS_LOG_MAX_ENTRIES} kept. */
export function parseAccessLog(value: unknown): AccessLogEntry[] {
  if (!Array.isArray(value)) return [];
  const entries = value.map(parseAccessLogEntry).filter((entry): entry is AccessLogEntry => entry !== null);
  return entries.slice(Math.max(0, entries.length - ACCESS_LOG_MAX_ENTRIES));
}

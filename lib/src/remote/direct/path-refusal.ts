/**
 * What a Burrow knows when a direct-only session held to a path policy ends
 * for its path (`docs/specs/remote-network.md` -> "Local networks"): when, how,
 * and the one address it can name. Recorded by `EstablishedE2eSession`, shown
 * on the laptop, and carried to the phone in the goodbye. Imports nothing DOM
 * or Node, so the webview guards it with the same module.
 */

import {
  PATH_ADDRESS_SOURCES,
  SESSION_END_V1,
  isIpLiteral,
  type PathAddressSource,
  type SessionEndV1,
} from 'remote-lib-common';

import type { PathAddress } from './direct-peer';

/**
 * How the path ended the session: the path policy refused the attempt or its
 * selected pair, the attempt was given up, or the session was not direct by
 * `DIRECT_ONLY_DEADLINE_MS`.
 */
export const PATH_REFUSAL_KINDS = ['path-refused', 'given-up', 'deadline'] as const;
export type PathRefusalKind = (typeof PATH_REFUSAL_KINDS)[number];

/**
 * One direct-only session ended for its path. `address` and `addressSource`
 * come together or not at all: `observed` is the selected pair's remote end as
 * the Burrow's ICE agent reported it, `reported` an address the phone's offer
 * carried — a diagnostic, never path evidence ({@link PathAddress}).
 */
export interface PathRefusal {
  /** This machine's clock, epoch ms. */
  readonly at: number;
  readonly kind: PathRefusalKind;
  readonly address?: string;
  readonly addressSource?: PathAddressSource;
}

/** The record for one ending, from what the session's direct path knew. */
export function pathRefusal(at: number, kind: PathRefusalKind, address: PathAddress | null): PathRefusal {
  return address
    ? { at, kind, address: address.address, addressSource: address.source }
    : { at, kind };
}

/** The goodbye that tells the phone a refusal: the reason, and the address with its source where there is one. */
export function goodbyeFor(refusal: PathRefusal | null): SessionEndV1 {
  if (!refusal) return SESSION_END_V1;
  const { address, addressSource } = refusal;
  return address !== undefined && addressSource !== undefined
    ? { v: 1, t: 'session-end', reason: 'network-not-allowed', address, addressSource }
    : { v: 1, t: 'session-end', reason: 'network-not-allowed' };
}

/**
 * Whether `value` is a {@link PathRefusal} a panel can render: a finite `at`, a
 * known kind, and an IP literal with a known source, or neither.
 */
export function isPathRefusal(value: unknown): value is PathRefusal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const refusal = value as Record<string, unknown>;
  if (typeof refusal.at !== 'number' || !Number.isFinite(refusal.at)) return false;
  if (!(PATH_REFUSAL_KINDS as readonly unknown[]).includes(refusal.kind)) return false;
  if (refusal.address === undefined && refusal.addressSource === undefined) return true;
  return isIpLiteral(refusal.address) && (PATH_ADDRESS_SOURCES as readonly unknown[]).includes(refusal.addressSource);
}

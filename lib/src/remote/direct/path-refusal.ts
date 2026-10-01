/**
 * What a Burrow knows when a direct-only session held to a path policy ends
 * for its path (`docs/specs/remote-network.md` -> "Local networks"): when, how,
 * which end, and the one address it can name. Recorded by `EstablishedE2eSession`, shown
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

import type { PathEnd, RefusedEnd } from './direct-peer';

/**
 * How the path ended the session: the path policy refused the attempt or its
 * selected pair, the attempt was given up, or the session was not direct by
 * `DIRECT_ONLY_DEADLINE_MS`.
 */
export const PATH_REFUSAL_KINDS = ['path-refused', 'given-up', 'deadline'] as const;
export type PathRefusalKind = (typeof PATH_REFUSAL_KINDS)[number];

/**
 * One direct-only session ended for its path ({@link RefusedEnd}). `end` is
 * absent where neither end is known. `address` and `addressSource` — the
 * phone's, so only with `end: 'remote'` — come together or not at all:
 * `observed` is the selected pair's remote end as the Burrow's ICE agent
 * reported it, `reported` an address the phone's offer carried, a diagnostic
 * and never path evidence. `localAddress` — only with `end: 'local'` — is this
 * machine's own end of the refused pair.
 */
export type PathRefusal =
  | { readonly at: number; readonly kind: PathRefusalKind }
  | {
      readonly at: number;
      readonly kind: PathRefusalKind;
      readonly end: 'remote';
      readonly address?: string;
      readonly addressSource?: PathAddressSource;
    }
  | { readonly at: number; readonly kind: PathRefusalKind; readonly end: 'local'; readonly localAddress?: string };

/** The record for one ending, from what the session's direct path knew. */
export function pathRefusal(at: number, kind: PathRefusalKind, refused: RefusedEnd | null): PathRefusal {
  if (!refused) return { at, kind };
  if (refused.end === 'local') {
    return refused.address === null
      ? { at, kind, end: 'local' }
      : { at, kind, end: 'local', localAddress: refused.address };
  }
  const { address } = refused;
  return address
    ? { at, kind, end: 'remote', address: address.address, addressSource: address.source }
    : { at, kind, end: 'remote' };
}

/**
 * The goodbye that tells the phone a refusal: the reason, and the phone's
 * address with its source where the refusal names one. **Never this machine's
 * address**, and a refusal of this end carries none, so the phone reads its
 * generic direct-failure copy.
 */
export function goodbyeFor(refusal: PathRefusal | null): SessionEndV1 {
  if (!refusal) return SESSION_END_V1;
  if (!('address' in refusal) || refusal.address === undefined || refusal.addressSource === undefined) {
    return { v: 1, t: 'session-end', reason: 'network-not-allowed' };
  }
  const { address, addressSource } = refusal;
  return { v: 1, t: 'session-end', reason: 'network-not-allowed', address, addressSource };
}

const PATH_ENDS: readonly PathEnd[] = ['local', 'remote'];

/**
 * Whether `value` is a {@link PathRefusal} a panel can render: a finite `at`, a
 * known kind, and per end only its own fields — an IP literal with a known
 * source for `remote`, or neither; an IP literal or none for `local`; nothing
 * with no end.
 */
export function isPathRefusal(value: unknown): value is PathRefusal {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const refusal = value as Record<string, unknown>;
  if (typeof refusal.at !== 'number' || !Number.isFinite(refusal.at)) return false;
  if (!(PATH_REFUSAL_KINDS as readonly unknown[]).includes(refusal.kind)) return false;
  const { end, address, addressSource, localAddress } = refusal;
  if (end !== undefined && !(PATH_ENDS as readonly unknown[]).includes(end)) return false;
  if (end !== 'local' && localAddress !== undefined) return false;
  if (end === 'local' && localAddress !== undefined && !isIpLiteral(localAddress)) return false;
  if (address === undefined && addressSource === undefined) return true;
  return (
    end === 'remote' &&
    isIpLiteral(address) &&
    (PATH_ADDRESS_SOURCES as readonly unknown[]).includes(addressSource)
  );
}

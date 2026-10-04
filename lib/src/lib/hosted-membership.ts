import { useSyncExternalStore } from 'react';
import { getPlatform } from './platform';
import type { ManagedVoicePort } from './platform/managed-voice-types';

/**
 * Whether this machine's user is a Dormouse Hosted member, as the renderer
 * knows it (`docs/specs/alert.md` -> "Settings dialog"):
 *
 * - `member`: the account's subscription covers this machine;
 * - `not-member`: a Hosted build that is not covered;
 * - `unavailable`: no answer to give — a self-host build, a host with no
 *   Hosted mode, or a Hosted build whose host has not answered yet. Nothing
 *   about Hosted is offered on this answer.
 *
 * The one seam every Hosted offer in the renderer reads. Until desktop sign-in
 * feeds the account's entitlement here, it is derived from managed voice: only
 * a Hosted build's adapter carries a `managedVoice` port, and a saved voice
 * token is the only grant a desktop holds today.
 */
export type HostedMembership = 'member' | 'not-member' | 'unavailable';

function port(): ManagedVoicePort | undefined {
  try {
    return getPlatform().managedVoice;
  } catch {
    return undefined;
  }
}

/** The current answer; a string, so it is a stable `useSyncExternalStore` snapshot. */
export function getHostedMembership(): HostedMembership {
  const status = port()?.status();
  if (!status) return 'unavailable';
  return status.configured ? 'member' : 'not-member';
}

export function subscribeToHostedMembership(listener: () => void): () => void {
  return port()?.subscribe(listener) ?? (() => {});
}

export function useHostedMembership(): HostedMembership {
  return useSyncExternalStore(subscribeToHostedMembership, getHostedMembership);
}

import { useSyncExternalStore } from 'react';
import { getPlatform } from './platform';
import type { ManagedVoicePort } from './platform/managed-voice-types';

/**
 * Whether this machine's user is a Dormouse Hosted member: `unavailable` is a
 * build with no Hosted mode (self-host included) or a host that has not
 * answered, on which nothing about Hosted is offered. The renderer's one
 * membership seam; until desktop sign-in feeds it the account's entitlement it
 * reads managed voice, whose port only a Hosted build carries.
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

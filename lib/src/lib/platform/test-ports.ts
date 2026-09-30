/**
 * Stand-ins for the optional platform ports Settings → Network reads — the
 * updater's and managed voice's — for its stories and tests. Imports no test
 * framework, since the Storybook preview loads it
 * (`lib/src/host/remote/test-burrow-link.ts` keeps the same rule).
 */

import { DEFAULT_MANAGED_VOICE_ID, type ManagedVoicePort } from './managed-voice-types';
import type { UpdatesPort, UpdatesSnapshot } from './types';

/** An updater whose last successful check was `checkedAt`; Check now succeeds at once. */
export function makeStubUpdatesPort(checkedAt: number | null): UpdatesPort & { readonly checks: number } {
  let snapshot: UpdatesSnapshot = { checkedAt, checking: false };
  let checks = 0;
  const listeners = new Set<() => void>();
  return {
    get checks() {
      return checks;
    },
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    checkNow: () => {
      checks += 1;
      snapshot = { checkedAt: Date.now(), checking: false };
      for (const listener of listeners) listener();
    },
  };
}

/** A managed-voice port with a token saved, or not; it speaks nothing. */
export function makeStubManagedVoicePort(configured: boolean): ManagedVoicePort {
  const status = { configured, voiceId: DEFAULT_MANAGED_VOICE_ID };
  return {
    offerSetup: false,
    status: () => status,
    subscribe: () => () => {},
    configure: async () => ({ ok: false, reason: 'unavailable' }),
    speak: async () => ({ ok: false, reason: 'a stub speaks nothing' }),
  };
}

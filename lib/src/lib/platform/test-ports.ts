/**
 * Stand-ins for the optional platform ports Settings → Network reads — the
 * updater's and managed voice's — for its stories and tests. Imports no test
 * framework, since the Storybook preview loads it
 * (`lib/src/host/remote/test-burrow-link.ts` keeps the same rule).
 */

import { DEFAULT_MANAGED_VOICE_ID, type ManagedVoicePort } from './managed-voice-types';
import type { UpdatesPort, UpdatesSnapshot } from './types';

/** An updater whose last successful check was `checkedAt`; Check now succeeds at once. */
export function makeStubUpdatesPort(checkedAt: number | null): UpdatesPort {
  let snapshot: UpdatesSnapshot = { checkedAt, checking: false };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    checkNow: () => {
      snapshot = { checkedAt: Date.now(), checking: false };
      for (const listener of listeners) listener();
    },
  };
}

/**
 * A managed-voice port with a token saved, or not, and Hosted's last word on
 * the plan; choosing a voice takes, and it speaks nothing.
 */
export function makeStubManagedVoicePort(configured: boolean, notEntitled = false): ManagedVoicePort {
  let status = { configured, voiceId: DEFAULT_MANAGED_VOICE_ID, notEntitled };
  const listeners = new Set<() => void>();
  return {
    status: () => status,
    subscribe: (listener) => {
      listeners.add(listener);
      return () => void listeners.delete(listener);
    },
    configure: async ({ voiceId }) => {
      status = { ...status, voiceId };
      for (const listener of listeners) listener();
      return { ok: true, ...status };
    },
    speak: async () => ({ ok: false, reason: 'a stub speaks nothing' }),
  };
}

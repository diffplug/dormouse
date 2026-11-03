/**
 * The Burrow asking its Relay which of its passkeys its account no longer
 * holds, and revoking each it names (`docs/specs/remote-security-model.md` ->
 * "Relay-named revocation"). It sends credential ids and nothing else of a
 * record, and all a Relay's answer can do is revoke what was asked about.
 */

import {
  API_ROUTES,
  MAX_PASSKEY_QUERY_IDS,
  type BurrowAclRecord,
  type PasskeysRemovedRequest,
  type PasskeysRemovedResponse,
} from 'remote-lib-common';

import { realTimer, type RemoteTimer } from '../ws';
import { burrowRequest, type BurrowFetchOptions } from './burrow-fetch';

/**
 * The least time between two asks, however often a Relay nudges: the frame is
 * free for a hostile one to send, and each answer costs this process a request.
 */
export const PASSKEY_QUERY_SPACING_MS = 5_000;

/** How long after an ask that got no usable answer it is tried again. */
export const PASSKEY_QUERY_RETRY_MS = 60_000;

/**
 * How many times one socket open or nudge retries, its socket still up. Past
 * them the next open or nudge asks; Hosted's sweep sends one hourly.
 */
export const PASSKEY_QUERY_RETRIES = 3;

export interface PasskeySyncDeps extends Pick<BurrowFetchOptions, 'enrollment' | 'fetch'> {
  /** Whether the relay socket is up: a Burrow without one asks nothing, its next open asking again. */
  readonly connected: () => boolean;
  /** The Burrow's active records, read at each ask. */
  readonly activeRecords: () => readonly BurrowAclRecord[];
  /** `BurrowService.revoke` of one credential, as requester `relay`. */
  readonly revoke: (passkeyCredentialId: string) => Promise<unknown>;
  readonly setTimer?: RemoteTimer;
}

export interface PasskeySync {
  /** The socket opened or the Relay nudged: ask, now or when the spacing allows. */
  request(): void;
  /** This Burrow is gone: nothing more is asked or revoked, and no timer stays armed. */
  stop(): void;
}

/**
 * Those of `credentialIds` the Relay named: an id it was not asked about goes
 * no further. `'refused'` for a 4xx, which no retry changes: a Relay too old to
 * have the route, or one that no longer takes this token. Throws on anything
 * else that is not an answer, as a retry might get one.
 */
async function askRelay(
  options: BurrowFetchOptions,
  credentialIds: readonly string[],
): Promise<readonly string[] | 'refused'> {
  const response = await burrowRequest(options, API_ROUTES.burrowPasskeysRemoved, {
    credentialIds: [...credentialIds],
  } satisfies PasskeysRemovedRequest);
  if (response.status >= 400 && response.status < 500) return 'refused';
  if (!response.ok) throw new Error(`the Relay answered ${response.status}`);
  const removed = ((await response.json()) as Partial<PasskeysRemovedResponse> | null)?.removed;
  if (!Array.isArray(removed)) throw new Error('the Relay’s answer was not a list');
  const named = new Set<unknown>(removed);
  return credentialIds.filter((id) => named.has(id));
}

/**
 * One running Burrow's asking. **Only one ask runs at a time**, and a nudge
 * during it or its spacing asks once more after, so a removal that commits
 * behind an ask already answered still reaches the ACL.
 */
export function createPasskeySync(deps: PasskeySyncDeps): PasskeySync {
  const setTimer = deps.setTimer ?? realTimer;
  let stopped = false;
  let busy = false;
  let pending = false;
  let retries = PASSKEY_QUERY_RETRIES;
  let cancelTimer: (() => void) | null = null;

  /** Ask about every active record, batch by batch. Whether it is worth asking again. */
  const ask = async (): Promise<boolean> => {
    if (!deps.connected()) return false;
    const ids = [...new Set(deps.activeRecords().map((record) => record.passkeyCredentialId))];
    try {
      for (let start = 0; start < ids.length; start += MAX_PASSKEY_QUERY_IDS) {
        const removed = await askRelay(deps, ids.slice(start, start + MAX_PASSKEY_QUERY_IDS));
        if (removed === 'refused') return false;
        for (const id of removed) {
          if (stopped) return false;
          // A save that fails still leaves the phone refused (`BurrowService.revoke`).
          await deps.revoke(id).catch((error: unknown) => {
            console.warn('[burrow] could not revoke a removed passkey', error);
          });
        }
        if (stopped) return false;
      }
      return false;
    } catch (error) {
      console.warn('[burrow] could not ask the Relay which passkeys it removed', error);
      return true;
    }
  };

  const run = (): void => {
    busy = true;
    pending = false;
    void ask().then((again) => {
      if (stopped) return;
      const retrying = again && retries > 0;
      if (retrying) {
        retries -= 1;
        pending = true;
      }
      cancelTimer = setTimer(
        () => {
          cancelTimer = null;
          busy = false;
          if (pending) run();
        },
        retrying ? PASSKEY_QUERY_RETRY_MS : PASSKEY_QUERY_SPACING_MS,
      );
    });
  };

  return {
    request() {
      if (stopped) return;
      retries = PASSKEY_QUERY_RETRIES;
      pending = true;
      if (!busy) run();
    },
    stop() {
      stopped = true;
      cancelTimer?.();
      cancelTimer = null;
    },
  };
}

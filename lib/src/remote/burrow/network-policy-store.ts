/**
 * The network policy as an external store a Settings panel reads
 * (`docs/specs/remote-network.md` -> "Policy"). Like `one-time-store.ts`, it
 * holds nothing but a mirror: the policy lives host-side, in the Burrow
 * service, one round trip away, and only the service writes it.
 *
 * **The `network-policy` event is the authority.** The service sends the
 * complete result on every change (`service-protocol.ts` ->
 * `NetworkPolicyEvent`), so the store replaces rather than merges,
 * and reads `networkPolicy` only to seed a first subscriber and to re-seed a
 * panel that opens — which also re-reads this machine's interfaces.
 */

import { isNetworkPolicyResult, type NetworkPolicy, type NetworkPolicyResult } from '../network-policy';
import { burrowLink, describeBurrowError, requireBurrowLink } from './burrow-status-store';

/**
 * `unsupported` is a build with no Burrow service behind it. `error` means
 * there is a service and it would not say.
 */
export type NetworkPolicyStoreState =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'ready'; network: NetworkPolicyResult }
  | { kind: 'error'; message: string };

const UNSUPPORTED: NetworkPolicyStoreState = { kind: 'unsupported' };
const LOADING: NetworkPolicyStoreState = { kind: 'loading' };

let snapshot: NetworkPolicyStoreState = LOADING;
const listeners = new Set<() => void>();
let unsubscribeFromLink: (() => void) | null = null;

/**
 * Moved by every event and every read or set this store starts, so an answer
 * to a question asked before the latest one can never overwrite it.
 */
let generation = 0;

function publish(next: NetworkPolicyStoreState): void {
  snapshot = next;
  for (const listener of listeners) listener();
}

export function getNetworkPolicySnapshot(): NetworkPolicyStoreState {
  return snapshot;
}

export function subscribeToNetworkPolicy(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const active = burrowLink();
    if (active) {
      unsubscribeFromLink = active.on('network-policy', (data) => {
        // Dropped rather than rendered: the panel keys its choices off these fields.
        if (!isNetworkPolicyResult(data)) return;
        // Field by field: the event is the result plus its `name`.
        const { policy, levels, interfaces } = data;
        generation++;
        publish({ kind: 'ready', network: { policy, levels, interfaces } });
      });
      void refreshNetworkPolicy();
    } else {
      publish(UNSUPPORTED);
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeFromLink?.();
      unsubscribeFromLink = null;
      snapshot = LOADING;
      generation++;
    }
  };
}

/** Re-read `networkPolicy`: the policy, and this machine's interfaces as they are now. */
export async function refreshNetworkPolicy(): Promise<void> {
  const active = burrowLink();
  if (!active) {
    publish(UNSUPPORTED);
    return;
  }
  const mine = ++generation;
  try {
    const network = await active.command('networkPolicy');
    if (mine !== generation) return;
    publish(
      isNetworkPolicyResult(network)
        ? { kind: 'ready', network }
        : { kind: 'error', message: describeBurrowError(undefined) },
    );
  } catch (error) {
    if (mine !== generation) return;
    publish({ kind: 'error', message: describeBurrowError(error) });
  }
}

/** The tail of {@link changeNetworkPolicy}'s queue, settled either way. */
let changing: Promise<void> = Promise.resolve();

/**
 * Hold the policy `change` makes of the service's latest answer, or nothing
 * when it answers `null`. **Changes run one at a time**, each reading the
 * answer the one before it left, so a second click before the first lands
 * builds on it rather than on what the panel showed, which the first would
 * otherwise lose.
 *
 * The service's event arrives before its answer; the answer is applied only
 * when none has. Rejections propagate verbatim — the service's refusals are
 * written to be read.
 */
export function changeNetworkPolicy(
  change: (network: NetworkPolicyResult) => NetworkPolicy | null,
): Promise<void> {
  const run = changing.then(async () => {
    const current = snapshot;
    if (current.kind !== 'ready') {
      throw new Error(current.kind === 'error' ? current.message : 'The network setting is not loaded yet.');
    }
    const policy = change(current.network);
    if (!policy) return;
    const active = requireBurrowLink();
    const mine = ++generation;
    const network = await active.command('setNetworkPolicy', { policy });
    if (mine === generation && isNetworkPolicyResult(network)) publish({ kind: 'ready', network });
  });
  changing = run.catch(() => {});
  return run;
}

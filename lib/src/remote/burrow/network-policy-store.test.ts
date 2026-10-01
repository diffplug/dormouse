import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BurrowLink } from '../../lib/platform/types';
import { makeEventedBurrowLink, networkOn, type EventedBurrowLink } from '../../host/remote/test-burrow-link';
import type { NetworkPolicyResult } from '../network-policy';

let burrowLink: BurrowLink | undefined;

vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ burrow: burrowLink }),
}));

import {
  changeNetworkPolicy,
  getNetworkPolicySnapshot,
  refreshNetworkPolicy,
  subscribeToNetworkPolicy,
} from './network-policy-store';

/** A link answering `command`, installed as the platform's. */
function fakeLink(command: (cmd: string, params?: unknown) => Promise<unknown>) {
  const link = makeEventedBurrowLink(vi.fn(command));
  burrowLink = link;
  return link;
}

/** One `network-policy` event carrying `result`, as the service sends it. */
function emitResult(link: EventedBurrowLink<BurrowLink['command']>, result: unknown): void {
  link.emit('network-policy', { name: 'network-policy', ...(result as object) });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const LOCAL: NetworkPolicyResult = networkOn('hosted');
const NOTHING: NetworkPolicyResult = {
  ...LOCAL,
  policy: { level: 'nothing', allowed: [], autoUpdate: false },
};

let unsubscribe: (() => void) | null = null;

function subscribe() {
  unsubscribe = subscribeToNetworkPolicy(() => {});
}

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  burrowLink = undefined;
});

describe('network policy store', () => {
  it('is unsupported on a build with no Burrow service', () => {
    subscribe();
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'unsupported' });
  });

  it('seeds from networkPolicy and replaces the result on every event, without its name', async () => {
    const link = fakeLink(async () => NOTHING);
    subscribe();
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'loading' });
    await flush();
    expect(link.command).toHaveBeenCalledWith('networkPolicy');
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: NOTHING });

    emitResult(link, LOCAL);
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: LOCAL });
  });

  it('drops an event that is not a result it can render', async () => {
    const link = fakeLink(async () => LOCAL);
    subscribe();
    await flush();

    emitResult(link, { ...LOCAL, policy: { level: 'everything', allowed: [], autoUpdate: false } });
    emitResult(link, { policy: NOTHING.policy });
    link.emit('network-policy', undefined);
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: LOCAL });
  });

  it('never lets a read an event overtook overwrite the event', async () => {
    const read = deferred<unknown>();
    const link = fakeLink(() => read.promise);
    subscribe();

    emitResult(link, LOCAL);
    read.resolve(NOTHING);
    await flush();
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: LOCAL });
  });

  it('reports a read that failed or answered nonsense, and recovers on a re-read', async () => {
    let answer: () => unknown = () => {
      throw new Error('unknown burrow command: networkPolicy');
    };
    fakeLink(async () => answer());
    subscribe();
    await flush();
    expect(getNetworkPolicySnapshot()).toEqual({
      kind: 'error',
      message: 'unknown burrow command: networkPolicy',
    });

    answer = () => ({ enrolled: false });
    await refreshNetworkPolicy();
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'error', message: 'It did not answer.' });

    answer = () => LOCAL;
    await refreshNetworkPolicy();
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: LOCAL });
  });

  it('sets the whole policy, taking the answer only when no event did', async () => {
    const link = fakeLink(async (cmd) => (cmd === 'setNetworkPolicy' ? LOCAL : NOTHING));
    subscribe();
    await flush();

    await changeNetworkPolicy(() => LOCAL.policy);
    expect(link.command).toHaveBeenCalledWith('setNetworkPolicy', { policy: LOCAL.policy });
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: LOCAL });

    // The service's event arrives before its answer; the answer is then stale.
    link.command.mockImplementation(async (cmd) => {
      if (cmd !== 'setNetworkPolicy') return LOCAL;
      emitResult(link, NOTHING);
      return LOCAL;
    });
    await changeNetworkPolicy(() => NOTHING.policy);
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: NOTHING });
  });

  it('passes a refused set through to the caller', async () => {
    fakeLink(async (cmd) => {
      if (cmd === 'setNetworkPolicy') throw new Error('This build does not offer the relay level.');
      return LOCAL;
    });
    subscribe();
    await flush();
    await expect(changeNetworkPolicy(() => ({ level: 'relay', allowed: [], autoUpdate: false }))).rejects.toThrow(
      'does not offer',
    );
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: LOCAL });
  });

  it('lets go of the link with its last subscriber, and re-reads for the next', async () => {
    const read = deferred<unknown>();
    const link = fakeLink(() => read.promise);
    subscribe();
    expect(link.listening('network-policy')).toBe(1);

    unsubscribe?.();
    unsubscribe = null;
    expect(link.listening('network-policy')).toBe(0);
    read.resolve(LOCAL);
    await flush();
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'loading' });

    link.command.mockImplementation(async () => NOTHING);
    subscribe();
    await flush();
    expect(getNetworkPolicySnapshot()).toEqual({ kind: 'ready', network: NOTHING });
  });
});

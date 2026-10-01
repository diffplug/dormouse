import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BurrowLink } from '../../lib/platform/types';
import {
  makeEventedBurrowLink,
  oneTimeWaiting,
  type EventedBurrowLink,
} from '../../host/remote/test-burrow-link';
import type { OneTimeState } from './one-time-runtime';

let burrowLink: BurrowLink | undefined;

vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ burrow: burrowLink }),
}));

import {
  endOneTime,
  getOneTimeSnapshot,
  openOneTime,
  refreshOneTime,
  subscribeToOneTime,
} from './one-time-store';

/** A link answering `command`, installed as the platform's. */
function fakeLink(command: (cmd: string, params?: unknown) => Promise<unknown>) {
  const link = makeEventedBurrowLink(vi.fn(command));
  burrowLink = link;
  return link;
}

/** One `one-time` event carrying `state`, as the service sends it. */
function emitState(link: EventedBurrowLink<BurrowLink['command']>, state: unknown): void {
  link.emit('one-time', { name: 'one-time', state });
}

/** A read the test answers by hand, so an event can land while it is in flight. */
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const CONNECTED: OneTimeState = { status: 'connected', label: 'Pixel 9', since: 1 };

let unsubscribe: (() => void) | null = null;

function subscribe() {
  unsubscribe = subscribeToOneTime(() => {});
}

afterEach(() => {
  unsubscribe?.();
  unsubscribe = null;
  burrowLink = undefined;
});

describe('one-time store', () => {
  it('is unsupported on a build with no Burrow service', () => {
    subscribe();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'unsupported' });
  });

  it('seeds from oneTimeStatus and replaces the state on every event', async () => {
    const link = fakeLink(async () => ({ status: 'idle' }));
    subscribe();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'loading' });
    await flush();
    expect(link.command).toHaveBeenCalledWith('oneTimeStatus');
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: { status: 'idle' } });

    emitState(link, CONNECTED);
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: CONNECTED });
  });

  it('drops an event that is not a state it can render', async () => {
    const link = fakeLink(async () => CONNECTED);
    subscribe();
    await flush();

    emitState(link, { status: 'connected' });
    emitState(link, { status: 'ended' });
    emitState(link, undefined);
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: CONNECTED });
  });

  it('never lets a read an event overtook overwrite the event', async () => {
    // The event was sent after the read was asked, so the read's answer is the
    // older of the two, whichever lands last.
    const read = deferred<unknown>();
    const link = fakeLink(() => read.promise);
    subscribe();

    emitState(link, CONNECTED);
    read.resolve(oneTimeWaiting());
    await flush();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: CONNECTED });
  });

  it('reports a read that failed or answered nonsense as an error', async () => {
    fakeLink(async () => {
      throw new Error('unknown burrow command: oneTimeStatus');
    });
    subscribe();
    await flush();
    expect(getOneTimeSnapshot()).toEqual({
      kind: 'error',
      message: 'unknown burrow command: oneTimeStatus',
    });
    unsubscribe?.();

    fakeLink(async () => ({ enrolled: false }));
    subscribe();
    await flush();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'error', message: 'It did not answer.' });
  });

  it('opens with no parameters, taking the answer only when no event did', async () => {
    const waiting = oneTimeWaiting();
    const link = fakeLink(async (cmd) => (cmd === 'oneTimeOpen' ? waiting : { status: 'idle' }));
    subscribe();
    await flush();

    await openOneTime();
    expect(link.command).toHaveBeenCalledWith('oneTimeOpen');
    expect(link.command.mock.calls.find(([cmd]) => cmd === 'oneTimeOpen')).toEqual(['oneTimeOpen']);
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: waiting });

    // The service's events arrive before its answer; the answer is then stale.
    link.command.mockImplementation(async (cmd) => {
      if (cmd !== 'oneTimeOpen') return { status: 'idle' };
      emitState(link, CONNECTED);
      return waiting;
    });
    await openOneTime();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: CONNECTED });
  });

  it('passes a refused open through to the caller', async () => {
    fakeLink(async (cmd) => {
      if (cmd === 'oneTimeOpen') throw new Error('A phone is already connected');
      return CONNECTED;
    });
    subscribe();
    await flush();
    await expect(openOneTime()).rejects.toThrow('A phone is already connected');
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: CONNECTED });
  });

  it('re-reads after an end, whose answer carries no state', async () => {
    let state: OneTimeState = CONNECTED;
    const link = fakeLink(async (cmd) => {
      if (cmd === 'oneTimeEnd') {
        state = { status: 'ended', reason: 'user-ended' };
        return {};
      }
      return state;
    });
    subscribe();
    await flush();

    await endOneTime();
    expect(link.command).toHaveBeenCalledWith('oneTimeEnd');
    expect(getOneTimeSnapshot()).toEqual({
      kind: 'ready',
      state: { status: 'ended', reason: 'user-ended' },
    });
  });

  it('lets go of the link with its last subscriber, and re-reads for the next', async () => {
    const read = deferred<unknown>();
    const link = fakeLink(() => read.promise);
    subscribe();
    expect(link.listening('one-time')).toBe(1);

    unsubscribe?.();
    unsubscribe = null;
    expect(link.listening('one-time')).toBe(0);
    // A read in flight for a subscriber that left cannot land on the next one.
    read.resolve(CONNECTED);
    await flush();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'loading' });

    link.command.mockImplementation(async () => ({ status: 'idle' }));
    subscribe();
    await flush();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: { status: 'idle' } });
  });

  it('keeps a state already read through a failed re-read, and takes the next answer', async () => {
    let answer: () => unknown = () => CONNECTED;
    fakeLink(async () => answer());
    subscribe();
    await flush();

    answer = () => {
      throw new Error('bridge timed out');
    };
    await refreshOneTime();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: CONNECTED });

    answer = () => ({ status: 'idle' });
    await refreshOneTime();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: { status: 'idle' } });
  });

  it.each([
    ['answers having lost its event', async () => ({})],
    [
      'is refused',
      async () => {
        throw new Error('burrow command timed out: oneTimeEnd');
      },
    ],
  ])('never keeps a state from before an End that %s through a failed read', async (_, end) => {
    let fail = false;
    fakeLink(async (cmd) => {
      if (cmd === 'oneTimeEnd') return end();
      if (fail) throw new Error('bridge timed out');
      return CONNECTED;
    });
    subscribe();
    await flush();

    fail = true;
    await endOneTime().catch(() => {});
    // The panel opening after it re-reads too.
    await refreshOneTime();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'error', message: 'bridge timed out' });
  });

  it('re-reads on request, which is what recovers a failed first read', async () => {
    let fail = true;
    fakeLink(async () => {
      if (fail) throw new Error('not yet');
      return CONNECTED;
    });
    subscribe();
    await flush();
    expect(getOneTimeSnapshot().kind).toBe('error');

    fail = false;
    await refreshOneTime();
    expect(getOneTimeSnapshot()).toEqual({ kind: 'ready', state: CONNECTED });
  });
});

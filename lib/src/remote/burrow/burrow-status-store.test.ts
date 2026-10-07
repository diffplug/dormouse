import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BurrowLink } from '../../lib/platform/types';
import { HOSTED_ENROLLMENT_END_REASONS } from '../../host/remote/service-protocol';

let burrowLink: BurrowLink | undefined;

vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ burrow: burrowLink }),
}));

import {
  clearBurrowEnrollment,
  getBurrowStatusSnapshot,
  subscribeToBurrowStatus,
} from './burrow-status-store';

afterEach(() => {
  burrowLink = undefined;
  vi.useRealTimers();
});

describe('burrow status polling', () => {
  it('lets a slow status timeout commit without overlapping polls superseding it', async () => {
    vi.useFakeTimers();
    let activeReads = 0;
    let maxActiveReads = 0;
    const command = vi.fn(
      () =>
        new Promise<unknown>((_resolve, reject) => {
          activeReads++;
          maxActiveReads = Math.max(maxActiveReads, activeReads);
          setTimeout(() => {
            activeReads--;
            reject(new Error('status timed out'));
          }, 15_000);
        }),
    );
    burrowLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const unsubscribe = subscribeToBurrowStatus(() => {});
    try {
      expect(command).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(14_000);
      expect(command).toHaveBeenCalledTimes(1);
      expect(maxActiveReads).toBe(1);
      expect(getBurrowStatusSnapshot()).toEqual({ kind: 'loading' });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(maxActiveReads).toBe(1);
      expect(getBurrowStatusSnapshot()).toEqual({
        kind: 'error',
        message: 'status timed out',
      });
    } finally {
      unsubscribe();
    }
  });

  it('keeps a status already read through a failed poll, and takes the next answer', async () => {
    vi.useFakeTimers();
    let answer: () => unknown = () => ({ enrolled: true, connection: 'connecting' });
    burrowLink = {
      command: vi.fn(async () => answer()),
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const unsubscribe = subscribeToBurrowStatus(() => {});
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(getBurrowStatusSnapshot()).toMatchObject({ kind: 'ready', status: { connection: 'connecting' } });

      answer = () => {
        throw new Error('bridge timed out');
      };
      await vi.advanceTimersByTimeAsync(2000);
      expect(getBurrowStatusSnapshot()).toMatchObject({ kind: 'ready', status: { connection: 'connecting' } });

      answer = () => ({ enrolled: true, connection: 'connected' });
      await vi.advanceTimersByTimeAsync(2000);
      expect(getBurrowStatusSnapshot()).toMatchObject({ kind: 'ready', status: { connection: 'connected' } });
    } finally {
      unsubscribe();
    }
  });
});

describe('re-reading after a mutation', () => {
  /**
   * The poll may coalesce, because any recent answer will do. A lifecycle
   * command may not: a `status` issued before the disconnect answers the
   * question as it stood beforehand, so joining it would report this machine
   * still enrolled after its enrollment was successfully deleted — the exact
   * claim the service's delete-first ordering exists to prevent.
   */
  it('does not resolve on a status read that predates the command', async () => {
    let enrolled = true;
    /** Set while the first `status` is deliberately left hanging. */
    let releaseFirstRead: (() => void) | null = null;

    const statusAnswer = () => ({
      enrolled,
      relayOrigin: 'https://laptop.tailnet.ts.net',
      burrowId: 'burrow-1',
      connection: 'connected',
      pairedClients: 1,
    });

    let seenStatus = 0;
    const command = vi.fn(async (cmd: string) => {
      if (cmd === 'clearEnrollment') {
        enrolled = false;
        return null;
      }
      // Every `status` answers with enrollment as it stood when it was *called*.
      const answer = statusAnswer();
      if (++seenStatus > 1) return answer;
      return new Promise((resolve) => {
        releaseFirstRead = () => resolve(answer);
      });
    });
    burrowLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const unsubscribe = subscribeToBurrowStatus(() => {});
    try {
      // Subscribing issued a read that is still in flight, and still says enrolled.
      expect(releaseFirstRead).not.toBeNull();

      // Disconnect, and let its own re-read run to completion...
      await clearBurrowEnrollment();
      // ...then let the pre-disconnect read land. It must not win.
      releaseFirstRead!();
      // A full macrotask, not one microtask: the stale answer reaches the
      // generation check several microtasks after release (async `command`
      // adopting a promise, then the store's own await), so asserting sooner
      // passes whether or not the check exists.
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(getBurrowStatusSnapshot()).toMatchObject({
        kind: 'ready',
        status: { enrolled: false },
      });
    } finally {
      unsubscribe();
    }
  });
});

describe('re-subscribing', () => {
  /**
   * Closing the dialog while a read hangs and reopening it must issue a new
   * read. Coalescing onto the old one would answer the reopened dialog with a
   * status fetched for the closed one — and leave it on "Checking…" until that
   * read finally settles, which for a wedged Burrow service is the link's whole
   * command timeout.
   */
  it('issues a fresh read rather than joining one left over from a closed dialog', async () => {
    const releases: Array<() => void> = [];
    const command = vi.fn(
      () =>
        new Promise<unknown>((resolve) => {
          releases.push(() =>
            resolve({
              enrolled: true,
              relayOrigin: 'https://laptop.tailnet.ts.net',
              burrowId: 'burrow-1',
              connection: 'connected',
              pairedClients: 1,
            }),
          );
        }),
    );
    burrowLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    // Open, then close while that first read is still hanging.
    subscribeToBurrowStatus(() => {})();
    expect(command).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToBurrowStatus(() => {});
    try {
      expect(command).toHaveBeenCalledTimes(2);

      // The abandoned read landing must not commit for the reopened dialog...
      releases[0]!();
      await Promise.resolve();
      expect(getBurrowStatusSnapshot()).toEqual({ kind: 'loading' });

      // ...and the reopened dialog's own read must.
      releases[1]!();
      await Promise.resolve();
      expect(getBurrowStatusSnapshot()).toMatchObject({ kind: 'ready' });
    } finally {
      unsubscribe();
    }
  });
});

describe('publishing', () => {
  /**
   * The service answers with a fresh object every poll, so an unguarded write
   * would re-render the section twice a minute to paint identical text. The
   * sibling store this same dialog reads guards the same way (`setPushDevices`).
   */
  it('does not notify when a poll answers the same status again', async () => {
    vi.useFakeTimers();
    const status = {
      enrolled: true,
      relayOrigin: 'https://laptop.tailnet.ts.net',
      burrowId: 'burrow-1',
      connection: 'connected',
      pairedClients: 1,
    };
    // A new object each time, exactly as a round trip through the service gives.
    const command = vi.fn(async () => ({ ...status }));
    burrowLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const listener = vi.fn();
    const unsubscribe = subscribeToBurrowStatus(listener);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(listener).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3 * 2000);
      expect(command.mock.calls.length).toBeGreaterThan(1);
      expect(listener).toHaveBeenCalledTimes(1);

      // A real change still publishes.
      status.pairedClients = 2;
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(2);
    } finally {
      unsubscribe();
    }
  });
});


describe('a Hosted enrollment in the status', () => {
  it('reads one waiting without republishing it, and none of a shape it does not draw', async () => {
    vi.useFakeTimers();
    let hostedEnrollment: unknown = {
      status: 'waiting',
      userCode: '23AB-YZ9K',
      verificationUrl: 'https://hosted.dormouse.sh/enroll#23AB-YZ9K',
      expiresAt: 1_800_000_000_000,
      accountFull: false,
    };
    const command = vi.fn(async () => ({
      enrolled: false,
      serving: false,
      relayOrigin: 'https://relay.dormouse.sh',
      relayMode: 'hosted',
      burrowId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: 'ned-mac',
      offer: false,
      accountOrigin: null,
      // A fresh object every answer, as the bridge delivers it.
      ...(hostedEnrollment === undefined ? {} : { hostedEnrollment: structuredClone(hostedEnrollment) }),
    }));
    burrowLink = { command, respond: () => {}, notify: () => {}, on: () => () => {} };
    const listener = vi.fn();
    const unsubscribe = subscribeToBurrowStatus(listener);
    const shown = () => (getBurrowStatusSnapshot() as { status: { hostedEnrollment: unknown } }).status.hostedEnrollment;
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(shown()).toEqual(hostedEnrollment);
      await vi.advanceTimersByTimeAsync(3 * 2000);
      expect(listener).toHaveBeenCalledTimes(1);

      // A reason this build does not know is a failure with no sentence.
      hostedEnrollment = { status: 'ended', reason: 'toString' };
      await vi.advanceTimersByTimeAsync(2000);
      expect(shown()).toEqual({ status: 'ended', reason: 'failed' });
      // Every reason the service exports is read as itself, and so is redeeming.
      for (const reason of HOSTED_ENROLLMENT_END_REASONS) {
        hostedEnrollment = { status: 'ended', reason };
        await vi.advanceTimersByTimeAsync(2000);
        expect(shown()).toEqual({ status: 'ended', reason });
      }
      // A lost answer keeps the Burrow it names, and nothing it does not know.
      hostedEnrollment = { status: 'ended', reason: 'answer-lost', burrowId: 'B1', extra: true };
      await vi.advanceTimersByTimeAsync(2000);
      expect(shown()).toEqual({ status: 'ended', reason: 'answer-lost', burrowId: 'B1' });
      hostedEnrollment = { status: 'redeeming' };
      await vi.advanceTimersByTimeAsync(2000);
      expect(shown()).toEqual({ status: 'redeeming' });

      for (const malformed of [undefined, null, { status: 'waiting', userCode: 7 }, { status: 'gone' }]) {
        hostedEnrollment = malformed;
        await vi.advanceTimersByTimeAsync(2000);
        expect(shown(), JSON.stringify(malformed)).toBeNull();
      }
    } finally {
      unsubscribe();
    }
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RemoteHostLink } from '../../lib/platform/types';

let remoteHostLink: RemoteHostLink | undefined;

vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ remoteHost: remoteHostLink }),
}));

import {
  clearRemoteHostEnrollment,
  getRemoteHostStatusSnapshot,
  subscribeToRemoteHostStatus,
} from './host-status-store';

afterEach(() => {
  remoteHostLink = undefined;
  vi.useRealTimers();
});

describe('host status polling', () => {
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
    remoteHostLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const unsubscribe = subscribeToRemoteHostStatus(() => {});
    try {
      expect(command).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(14_000);
      expect(command).toHaveBeenCalledTimes(1);
      expect(maxActiveReads).toBe(1);
      expect(getRemoteHostStatusSnapshot()).toEqual({ kind: 'loading' });

      await vi.advanceTimersByTimeAsync(1_000);
      expect(maxActiveReads).toBe(1);
      expect(getRemoteHostStatusSnapshot()).toEqual({
        kind: 'error',
        message: 'status timed out',
      });
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
      relayUrl: 'https://laptop.tailnet.ts.net',
      hostId: 'host-1',
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
    remoteHostLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const unsubscribe = subscribeToRemoteHostStatus(() => {});
    try {
      // Subscribing issued a read that is still in flight, and still says enrolled.
      expect(releaseFirstRead).not.toBeNull();

      // Disconnect, and let its own re-read run to completion...
      await clearRemoteHostEnrollment();
      // ...then let the pre-disconnect read land. It must not win.
      releaseFirstRead!();
      await Promise.resolve();

      expect(getRemoteHostStatusSnapshot()).toMatchObject({
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
   * read finally settles, which for a wedged Host service is the link's whole
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
              relayUrl: 'https://laptop.tailnet.ts.net',
              hostId: 'host-1',
              connection: 'connected',
              pairedClients: 1,
            }),
          );
        }),
    );
    remoteHostLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    // Open, then close while that first read is still hanging.
    subscribeToRemoteHostStatus(() => {})();
    expect(command).toHaveBeenCalledTimes(1);

    const unsubscribe = subscribeToRemoteHostStatus(() => {});
    try {
      expect(command).toHaveBeenCalledTimes(2);

      // The abandoned read landing must not commit for the reopened dialog...
      releases[0]!();
      await Promise.resolve();
      expect(getRemoteHostStatusSnapshot()).toEqual({ kind: 'loading' });

      // ...and the reopened dialog's own read must.
      releases[1]!();
      await Promise.resolve();
      expect(getRemoteHostStatusSnapshot()).toMatchObject({ kind: 'ready' });
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
      relayUrl: 'https://laptop.tailnet.ts.net',
      hostId: 'host-1',
      connection: 'connected',
      pairedClients: 1,
    };
    // A new object each time, exactly as a round trip through the service gives.
    const command = vi.fn(async () => ({ ...status }));
    remoteHostLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const listener = vi.fn();
    const unsubscribe = subscribeToRemoteHostStatus(listener);
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

  /**
   * `offer` is the one nested field, so it is the one the mapped type cannot
   * help with — `Object.is` type-checks there too, and would re-render the
   * section every 2 s on an un-enrolled machine that has an offer, since the
   * service mints a fresh `{ origin }` per read. This test is the guard.
   */
  it('compares the offer by its origin, not by the object the poll minted', async () => {
    vi.useFakeTimers();
    let origin: string | null = 'https://ned-mac.tail9c2f1.ts.net';
    const command = vi.fn(async () => ({
      enrolled: false,
      relayUrl: null,
      hostId: null,
      connection: 'stopped',
      pairedClients: 0,
      suggestedLabel: 'ned-mac',
      // A new object every read, exactly as a round trip through the service gives.
      offer: origin === null ? null : { origin },
    }));
    remoteHostLink = {
      command,
      respond: () => {},
      notify: () => {},
      on: () => () => {},
    };

    const listener = vi.fn();
    const unsubscribe = subscribeToRemoteHostStatus(listener);
    try {
      await vi.advanceTimersByTimeAsync(0);
      expect(listener).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(3 * 2000);
      expect(command.mock.calls.length).toBeGreaterThan(1);
      expect(listener).toHaveBeenCalledTimes(1);

      // A different origin is a different offer, and must reach the card.
      origin = 'https://ned-mac-2.tail9c2f1.ts.net';
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(2);

      // And so is one that went away — redeeming an offer unlinks the file.
      origin = null;
      await vi.advanceTimersByTimeAsync(2000);
      expect(listener).toHaveBeenCalledTimes(3);
    } finally {
      unsubscribe();
    }
  });
});


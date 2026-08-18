import { describe, expect, it } from 'vitest';
import {
  LEASE_TTL_MS,
  decideWindowLease,
  isWindowLeaseRecord,
  runWindowLeaseCycle,
  type WindowLeaseIo,
  type WindowLeaseRecord,
} from './vscode-window-lease';

const SELF = 'window-a';
const NOW = 1_700_000_000_000;

describe('decideWindowLease', () => {
  it('takes an unclaimed lease', () => {
    expect(decideWindowLease(null, SELF, NOW)).toBe('take');
  });

  it('holds its own claim', () => {
    expect(decideWindowLease({ owner: SELF, heartbeatAt: NOW - 1_000 }, SELF, NOW)).toBe('hold');
  });

  it('holds its own claim even when the heartbeat has gone stale', () => {
    // Our own stale record means we were slow, not that we lost it — re-stamp
    // rather than racing ourselves for a lease we already hold.
    const stale = { owner: SELF, heartbeatAt: NOW - LEASE_TTL_MS * 10 };
    expect(decideWindowLease(stale, SELF, NOW)).toBe('hold');
  });

  it('waits while another window is heartbeating', () => {
    expect(decideWindowLease({ owner: 'window-b', heartbeatAt: NOW - 1_000 }, SELF, NOW)).toBe('wait');
  });

  it('takes over once another window stops heartbeating', () => {
    const abandoned = { owner: 'window-b', heartbeatAt: NOW - LEASE_TTL_MS - 1 };
    expect(decideWindowLease(abandoned, SELF, NOW)).toBe('take');
  });

  it('takes over a heartbeat stamped far in the future', () => {
    // Otherwise a clock jump locks every window out until the skew elapses.
    const skewed = { owner: 'window-b', heartbeatAt: NOW + LEASE_TTL_MS + 1 };
    expect(decideWindowLease(skewed, SELF, NOW)).toBe('take');
  });

  it('respects an explicit ttl', () => {
    const record = { owner: 'window-b', heartbeatAt: NOW - 100 };
    expect(decideWindowLease(record, SELF, NOW, 50)).toBe('take');
    expect(decideWindowLease(record, SELF, NOW, 1_000)).toBe('wait');
  });
});

describe('isWindowLeaseRecord', () => {
  it('accepts a well-formed record', () => {
    expect(isWindowLeaseRecord({ owner: 'w', heartbeatAt: NOW })).toBe(true);
  });

  it('rejects malformed or partial records', () => {
    expect(isWindowLeaseRecord(null)).toBe(false);
    expect(isWindowLeaseRecord({})).toBe(false);
    expect(isWindowLeaseRecord({ owner: 'w' })).toBe(false);
    expect(isWindowLeaseRecord({ owner: 5, heartbeatAt: NOW })).toBe(false);
    expect(isWindowLeaseRecord({ owner: 'w', heartbeatAt: 'soon' })).toBe(false);
    expect(isWindowLeaseRecord({ owner: 'w', heartbeatAt: NaN })).toBe(false);
  });
});


/** A shared lease file every simulated window reads and writes. */
function fakeFile(initial: WindowLeaseRecord | null = null) {
  let record = initial;
  let onSettle: (() => void) | null = null;
  return {
    get record() {
      return record;
    },
    set record(next: WindowLeaseRecord | null) {
      record = next;
    },
    /** Run `fn` while a claimant is between writing and confirming. */
    duringSettle(fn: () => void) {
      onSettle = fn;
    },
    io(selfId: string, now = () => NOW): WindowLeaseIo {
      return {
        read: async () => record,
        write: async (next) => {
          record = next;
        },
        now,
        settle: async () => {
          onSettle?.();
          onSettle = null;
        },
      };
    },
  };
}

describe('runWindowLeaseCycle', () => {
  it('claims an unheld lease and confirms it', async () => {
    const file = fakeFile();
    expect(await runWindowLeaseCycle(file.io(SELF), SELF)).toBe(true);
    expect(file.record?.owner).toBe(SELF);
  });

  it('does not claim while another window is alive', async () => {
    const file = fakeFile({ owner: 'window-b', heartbeatAt: NOW - 1_000 });
    expect(await runWindowLeaseCycle(file.io(SELF), SELF)).toBe(false);
    // And it must not have stamped over the live holder.
    expect(file.record?.owner).toBe('window-b');
  });

  it('takes over an abandoned lease', async () => {
    const file = fakeFile({ owner: 'window-b', heartbeatAt: NOW - LEASE_TTL_MS - 1 });
    expect(await runWindowLeaseCycle(file.io(SELF), SELF)).toBe(true);
    expect(file.record?.owner).toBe(SELF);
  });

  it('loses a contested takeover to the window that wrote last', async () => {
    const file = fakeFile({ owner: 'window-b', heartbeatAt: NOW - LEASE_TTL_MS - 1 });
    // Both windows judge the same record stale; the other one writes second.
    file.duringSettle(() => {
      file.record = { owner: 'window-c', heartbeatAt: NOW };
    });

    expect(await runWindowLeaseCycle(file.io(SELF), SELF)).toBe(false);
    expect(file.record?.owner).toBe('window-c');
  });

  it('renews without paying for a confirmation round trip', async () => {
    const file = fakeFile({ owner: SELF, heartbeatAt: NOW - 1_000 });
    let settled = false;
    const io = file.io(SELF);
    const held = await runWindowLeaseCycle(
      { ...io, settle: async () => { settled = true; } },
      SELF,
    );

    expect(held).toBe(true);
    expect(settled).toBe(false);
  });

  it('re-stamps the heartbeat on renewal', async () => {
    const file = fakeFile({ owner: SELF, heartbeatAt: NOW - 4_000 });
    await runWindowLeaseCycle(file.io(SELF, () => NOW), SELF);
    expect(file.record?.heartbeatAt).toBe(NOW);
  });

  it('propagates a write failure rather than claiming', async () => {
    const file = fakeFile();
    const io: WindowLeaseIo = {
      ...file.io(SELF),
      write: async () => {
        throw new Error('read-only filesystem');
      },
    };
    await expect(runWindowLeaseCycle(io, SELF)).rejects.toThrow('read-only');
  });

  it('hands over cleanly when the holder releases', async () => {
    const file = fakeFile({ owner: 'window-b', heartbeatAt: NOW - 1_000 });
    expect(await runWindowLeaseCycle(file.io(SELF), SELF)).toBe(false);

    // window-b disposed and unlinked the file.
    file.record = null;

    expect(await runWindowLeaseCycle(file.io(SELF), SELF)).toBe(true);
  });

  it('keeps exactly one holder across many contending windows', async () => {
    const file = fakeFile();
    const ids = ['w1', 'w2', 'w3', 'w4'];

    // First pass: one wins the empty file.
    const first = [];
    for (const id of ids) first.push(await runWindowLeaseCycle(file.io(id), id));
    expect(first.filter(Boolean)).toHaveLength(1);

    // Steady state: the winner renews, everyone else keeps standing down.
    const owner = file.record!.owner;
    const second = [];
    for (const id of ids) second.push(await runWindowLeaseCycle(file.io(id), id));
    expect(second.filter(Boolean)).toHaveLength(1);
    expect(file.record?.owner).toBe(owner);
  });
});

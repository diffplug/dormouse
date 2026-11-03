import { describe, expect, it } from 'vitest';
import {
  ACCESS_LOG_MAX_ENTRIES,
  ACCESS_LOG_MAX_REFUSALS,
  appendAccessLog,
  parseAccessLog,
  type AccessEvent,
  type AccessLogEntry,
} from './access-log';

const OTHERS_SHARE = ACCESS_LOG_MAX_ENTRIES - ACCESS_LOG_MAX_REFUSALS;

function entry(at: number, event: AccessEvent = 'connected'): AccessLogEntry {
  return { at, event, device: 'Unknown device', deviceId: at.toString(16).padStart(16, '0') };
}

function appendAll(entries: AccessLogEntry[]): AccessLogEntry[] {
  return entries.reduce<AccessLogEntry[]>(appendAccessLog, []);
}

describe('appendAccessLog', () => {
  it.each(['connection-denied', 'pairing-denied', 'one-time-denied'] as const)(
    'lets %s evict only older refusals, whatever device each names',
    (refusal) => {
      const kept = [entry(1, 'paired'), entry(2, 'connected'), entry(3, 'ended'), entry(4, 'revoked')];
      const refusals = Array.from({ length: ACCESS_LOG_MAX_ENTRIES * 2 }, (_, i) => entry(10 + i, refusal));

      const log = appendAll([...kept, ...refusals]);

      expect(log.slice(0, kept.length)).toEqual(kept);
      expect(log.slice(kept.length)).toEqual(refusals.slice(-ACCESS_LOG_MAX_REFUSALS));
    },
  );

  it('keeps every other kind to its own share, oldest first out, leaving refusals alone', () => {
    const refusal = entry(1, 'connection-denied');
    const others = Array.from({ length: ACCESS_LOG_MAX_ENTRIES * 2 }, (_, i) => entry(10 + i, 'attached'));

    const log = appendAll([refusal, ...others]);

    expect(log).toEqual([refusal, ...others.slice(-OTHERS_SHARE)]);
  });

  it('never holds more than the whole bound, and never mutates what it was given', () => {
    const before = [entry(1)];
    const after = appendAccessLog(before, entry(2));
    expect(before).toHaveLength(1);
    expect(after).toHaveLength(2);

    const full = Array.from({ length: ACCESS_LOG_MAX_ENTRIES * 2 }, (_, i) =>
      entry(i, i % 2 ? 'connection-denied' : 'ended'),
    );
    expect(appendAll(full)).toHaveLength(ACCESS_LOG_MAX_ENTRIES);
  });
});

describe('parseAccessLog', () => {
  it('bounds a stored log as an append does, so a file full of refusals frees the rest', () => {
    const paired = entry(1, 'paired');
    const refusals = Array.from({ length: ACCESS_LOG_MAX_ENTRIES }, (_, i) => entry(10 + i, 'connection-denied'));

    expect(parseAccessLog([paired, ...refusals])).toEqual([paired, ...refusals.slice(-ACCESS_LOG_MAX_REFUSALS)]);
  });
});

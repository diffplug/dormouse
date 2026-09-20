import { describe, expect, it } from 'vitest';
import { computeWorkspaceUnion, EMPTY_WORKSPACE_UNION } from './workspace-union';
import type { ActivityState } from './session-activity-store';

function activity(entries: Record<string, Partial<ActivityState>>): Map<string, ActivityState> {
  const base: ActivityState = {
    status: 'WATCHING_DISABLED',
    watchingEnabled: false,
    todo: false,
    notification: null,
    awaited: false,
    ringSeq: 0,
  };
  return new Map(Object.entries(entries).map(([id, partial]) => [id, { ...base, ...partial }]));
}

const episode = (id: string, startedAt: number) => ({ id, startedAt });

describe('computeWorkspaceUnion', () => {
  it('is empty when no surface owes attention', () => {
    const union = computeWorkspaceUnion(['a', 'b'], activity({ a: {}, b: { status: 'BUSY' } }));
    expect(union).toEqual(EMPTY_WORKSPACE_UNION);
  });

  it('reports ringing when any terminal Session is ALERT_RINGING', () => {
    const union = computeWorkspaceUnion(['a', 'b'], activity({ a: {}, b: { status: 'ALERT_RINGING' } }));
    expect(union).toEqual({ ringing: true, todo: false, count: 1, ringingSince: null });
  });

  it('reports todo for a flagged terminal Session', () => {
    const union = computeWorkspaceUnion(['a'], activity({ a: { todo: true } }));
    expect(union).toEqual({ ringing: false, todo: true, count: 1, ringingSince: null });
  });

  it('counts a browser Surface TODO (no ring) — status stays WATCHING_DISABLED', () => {
    const union = computeWorkspaceUnion(['web'], activity({ web: { status: 'WATCHING_DISABLED', todo: true } }));
    expect(union).toEqual({ ringing: false, todo: true, count: 1, ringingSince: null });
  });

  it('counts a surface that is both ringing and todo only once', () => {
    const union = computeWorkspaceUnion(['a'], activity({ a: { status: 'ALERT_RINGING', todo: true } }));
    expect(union).toEqual({ ringing: true, todo: true, count: 1, ringingSince: null });
  });

  it('sums distinct surfaces owing attention', () => {
    const union = computeWorkspaceUnion(
      ['a', 'b', 'c', 'd'],
      activity({ a: { status: 'ALERT_RINGING' }, b: { todo: true }, c: { status: 'BUSY' }, d: {} }),
    );
    expect(union).toEqual({ ringing: true, todo: true, count: 2, ringingSince: null });
  });

  it('ignores surface ids with no activity entry', () => {
    const union = computeWorkspaceUnion(['a', 'missing'], activity({ a: { todo: true } }));
    expect(union).toEqual({ ringing: false, todo: true, count: 1, ringingSince: null });
  });

  it('starts ringing at the earliest ringing member, whatever the iteration order', () => {
    const union = computeWorkspaceUnion(
      ['a', 'b', 'c'],
      activity({
        b: { status: 'ALERT_RINGING', episode: episode('later', 2_000) },
        a: { status: 'ALERT_RINGING', episode: episode('first', 1_000) },
        c: { todo: true },
      }),
    );
    expect(union).toEqual({ ringing: true, todo: true, count: 3, ringingSince: 1_000 });
  });

  it('ignores a quiet member\'s stale episode', () => {
    const union = computeWorkspaceUnion(
      ['a', 'b'],
      activity({
        a: { status: 'BUSY', episode: episode('stale', 1) },
        b: { status: 'ALERT_RINGING', episode: episode('live', 9) },
      }),
    );
    expect(union.ringingSince).toBe(9);
  });

  it('is empty for an empty surface set', () => {
    expect(computeWorkspaceUnion([], activity({ a: { todo: true } }))).toEqual(EMPTY_WORKSPACE_UNION);
  });
});

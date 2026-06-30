import { describe, expect, it } from 'vitest';
import { computeWorkspaceUnion, EMPTY_WORKSPACE_UNION } from './workspace-union';
import type { ActivityState } from './session-activity-store';

function activity(entries: Record<string, Partial<ActivityState>>): Map<string, ActivityState> {
  const base: ActivityState = { status: 'WATCHING_DISABLED', watchingEnabled: false, todo: false, notification: null };
  return new Map(Object.entries(entries).map(([id, partial]) => [id, { ...base, ...partial }]));
}

describe('computeWorkspaceUnion', () => {
  it('is empty when no surface owes attention', () => {
    const union = computeWorkspaceUnion(['a', 'b'], activity({ a: {}, b: { status: 'BUSY' } }));
    expect(union).toEqual(EMPTY_WORKSPACE_UNION);
  });

  it('reports ringing when any terminal Session is ALERT_RINGING', () => {
    const union = computeWorkspaceUnion(['a', 'b'], activity({ a: {}, b: { status: 'ALERT_RINGING' } }));
    expect(union).toEqual({ ringing: true, todo: false, count: 1 });
  });

  it('reports todo for a flagged terminal Session', () => {
    const union = computeWorkspaceUnion(['a'], activity({ a: { todo: true } }));
    expect(union).toEqual({ ringing: false, todo: true, count: 1 });
  });

  it('counts a browser Surface TODO (no ring) — status stays WATCHING_DISABLED', () => {
    const union = computeWorkspaceUnion(['web'], activity({ web: { status: 'WATCHING_DISABLED', todo: true } }));
    expect(union).toEqual({ ringing: false, todo: true, count: 1 });
  });

  it('counts a surface that is both ringing and todo only once', () => {
    const union = computeWorkspaceUnion(['a'], activity({ a: { status: 'ALERT_RINGING', todo: true } }));
    expect(union).toEqual({ ringing: true, todo: true, count: 1 });
  });

  it('sums distinct surfaces owing attention', () => {
    const union = computeWorkspaceUnion(
      ['a', 'b', 'c', 'd'],
      activity({ a: { status: 'ALERT_RINGING' }, b: { todo: true }, c: { status: 'BUSY' }, d: {} }),
    );
    expect(union).toEqual({ ringing: true, todo: true, count: 2 });
  });

  it('ignores surface ids with no activity entry', () => {
    const union = computeWorkspaceUnion(['a', 'missing'], activity({ a: { todo: true } }));
    expect(union).toEqual({ ringing: false, todo: true, count: 1 });
  });

  it('is empty for an empty surface set', () => {
    expect(computeWorkspaceUnion([], activity({ a: { todo: true } }))).toEqual(EMPTY_WORKSPACE_UNION);
  });
});

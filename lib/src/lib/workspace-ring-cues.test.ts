import { expect, it } from 'vitest';
import { WorkspaceRingCues } from './workspace-ring-cues';
import { DEFAULT_ACTIVITY_STATE } from './session-activity-store';

it('observes a lower-counter child without mistaking membership changes for rings', () => {
  const cues = new WorkspaceRingCues();
  const membership = new Map([['w', ['a', 'b']]]);
  const activity = new Map([
    ['a', { ...DEFAULT_ACTIVITY_STATE, status: 'ALERT_RINGING' as const, ringSeq: 7 }],
    ['b', { ...DEFAULT_ACTIVITY_STATE, status: 'ALERT_RINGING' as const, ringSeq: 1 }],
  ]);
  const update = () => cues.update(['w'], membership, activity);
  update();
  expect(cues.get('w')).toEqual({ sequence: 0, at: null });
  activity.set('b', { ...activity.get('b')!, ringSeq: 2 });
  update();
  const cue = cues.get('w');
  expect(cue.sequence).toBe(1);
  membership.set('w', ['b']);
  update();
  expect(cues.get('w')).toBe(cue);
  membership.set('w', ['a', 'b']);
  update();
  expect(cues.get('w')).toBe(cue);
  update(); // selecting a different Workspace doesn't change membership/evidence.
  expect(cues.get('w')).toBe(cue);
});

it('seeds new, transferred, or restored members and forgets closed Workspaces', () => {
  const cues = new WorkspaceRingCues();
  const activity = new Map([['a', { ...DEFAULT_ACTIVITY_STATE, status: 'ALERT_RINGING' as const, ringSeq: 5 }]]);
  cues.update(['w', 'v'], new Map([['w', ['a']]]), activity);
  cues.update(['w', 'v'], new Map([['v', ['a']]]), activity);
  expect(cues.get('v').sequence).toBe(0);
  activity.set('a', { ...activity.get('a')!, ringSeq: 6 });
  cues.update(['v'], new Map([['v', ['a']]]), activity);
  expect(cues.get('v').sequence).toBe(1);
  cues.update([], new Map(), activity);
  expect(cues.get('v')).toEqual({ sequence: 0, at: null });
});

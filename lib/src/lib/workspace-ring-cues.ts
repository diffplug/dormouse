import type { ActivityState } from './session-activity-store';

export interface WorkspaceRingCue { sequence: number; at: number | null }
interface Observation {
  members: Map<string, number>;
  cue: WorkspaceRingCue;
}

/** Presentation edges only: joining/leaving a Workspace is not a new alert. */
export class WorkspaceRingCues {
  private readonly workspaces = new Map<string, Observation>();

  /** Runs on every activity notification, so it mutates the retained observation in place. */
  update(workspaceIds: readonly string[], membership: ReadonlyMap<string, readonly string[]>, activity: ReadonlyMap<string, ActivityState>): void {
    const live = new Set(workspaceIds);
    for (const id of this.workspaces.keys()) if (!live.has(id)) this.workspaces.delete(id);
    for (const id of workspaceIds) {
      let observation = this.workspaces.get(id);
      if (!observation) this.workspaces.set(id, observation = { members: new Map(), cue: { sequence: 0, at: null } });
      const { members } = observation;
      const current = membership.get(id) ?? [];
      let fresh = false;
      for (const sessionId of current) {
        const state = activity.get(sessionId);
        if (!state) { members.delete(sessionId); continue; }
        const before = members.get(sessionId);
        if (before !== undefined && state.ringSeq > before && state.status === 'ALERT_RINGING') fresh = true;
        members.set(sessionId, state.ringSeq);
      }
      if (members.size > current.length) {
        for (const sessionId of members.keys()) if (!current.includes(sessionId)) members.delete(sessionId);
      }
      if (fresh) observation.cue = { sequence: observation.cue.sequence + 1, at: Date.now() };
    }
  }

  get(id: string): WorkspaceRingCue {
    return this.workspaces.get(id)?.cue ?? { sequence: 0, at: null };
  }
}

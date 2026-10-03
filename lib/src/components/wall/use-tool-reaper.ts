/**
 * When to reap and rehydrate this Wall's Tools (`docs/specs/dor-tool.md` ->
 * Reaping): a Tool out of sight — Doored, in an inactive Workspace, or in a
 * hidden webview — and silent for the idle threshold is stopped if it declared
 * itself safe to stop; a reaped one starts again once it is seen.
 */
import { useEffect, useRef, type MutableRefObject } from 'react';
import { getPlatform } from '../../lib/platform';
import type { PtyDataDetail } from '../../lib/platform/types';
import { isToolReaped } from '../../lib/tool-reap-store';
import type { LathWallEngine } from './lath-wall-engine';
import { rehydrateTool, stopTool, toolReapIdleMs } from './tool-reaper';
import { toolLeaves } from './use-tool-serving';
import type { DooredItem } from './wall-types';

const MAX_TICK_MS = 30_000;
const MIN_TICK_MS = 250;

function webviewHidden(): boolean {
  return typeof document !== 'undefined' && document.visibilityState === 'hidden';
}

export function useToolReaper({
  lath,
  doors,
  doorsRef,
  active,
  paused,
}: {
  lath: LathWallEngine;
  /** This Wall's Doors, as rendered: a change re-evaluates at once. */
  doors: readonly DooredItem[];
  doorsRef: MutableRefObject<DooredItem[]>;
  /** Whether this Wall's Workspace is the visible one. */
  active: boolean;
  /** A closing or transferring Workspace: nothing is stopped or started. */
  paused: () => boolean;
}): void {
  const activeRef = useRef(active);
  activeRef.current = active;
  const evaluate = useRef<() => void>(() => {});

  useEffect(() => {
    const platform = getPlatform();
    // The website playground runs no processes to reap.
    if (!platform.reapsTools) return;
    /** When each Tool left sight; absent while it is seen. */
    const outOfSight = new Map<string, number>();
    const lastOutput = new Map<string, number>();
    /** This Wall's Tools as of the last evaluation: other output is not theirs. */
    let tools = new Set<string>();
    const onData = (detail: PtyDataDetail) => { if (tools.has(detail.id)) lastOutput.set(detail.id, Date.now()); };
    // Read once: the tick is sized from it too.
    const idleMs = toolReapIdleMs();

    evaluate.current = () => {
      const now = Date.now();
      const hidden = !activeRef.current || webviewHidden();
      const doorIds = new Set(doorsRef.current.map(door => door.id));
      const leaves = toolLeaves(lath, doorsRef.current);
      tools = new Set(leaves.map(leaf => leaf.id));
      for (const id of outOfSight.keys()) if (!tools.has(id)) outOfSight.delete(id);
      for (const id of lastOutput.keys()) if (!tools.has(id)) lastOutput.delete(id);
      for (const { id } of leaves) {
        if (!hidden && !doorIds.has(id)) {
          outOfSight.delete(id);
          if (!paused()) rehydrateTool(lath, id);
          continue;
        }
        let since = outOfSight.get(id);
        if (since === undefined) outOfSight.set(id, since = now);
        // Never on the minimize or switch itself: the clock starts there.
        if (now - Math.max(since, lastOutput.get(id) ?? 0) < idleMs || paused()) continue;
        // `stopTool` declines whatever is not safe to stop.
        // Once stopped, a Tool shown meanwhile starts again at once.
        if (!isToolReaped(id)) void stopTool(lath, id).then(() => evaluate.current());
      }
    };

    platform.onPtyData(onData);
    const tick = Math.min(MAX_TICK_MS, Math.max(MIN_TICK_MS, idleMs / 4));
    const timer = setInterval(() => evaluate.current(), tick);
    const onVisibility = () => evaluate.current();
    document.addEventListener('visibilitychange', onVisibility);
    evaluate.current();
    return () => {
      evaluate.current = () => {};
      clearInterval(timer);
      platform.offPtyData(onData);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [lath, doorsRef, paused]);

  // A reattach or switch shows a reaped Tool: start it now, not at the next tick.
  useEffect(() => { evaluate.current(); }, [active, doors]);
}

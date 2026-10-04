import { useEffect } from 'react';
import { isToolParams } from './browser-surface';
import { becomeTerminalMeta, type LathWallEngine } from './lath-wall-engine';
import { retireToolRun, toolLeaves } from './use-tool-serving';
import type { DooredItem } from './wall-types';
import { registry } from '../../lib/terminal-store';
import { getTerminalPaneState, subscribeToTerminalPaneState } from '../../lib/terminal-state-store';
import { isToolReaped, isToolStopping } from '../../lib/tool-reap-store';
import { clearHoldLapse, isHoldLapsed, isRunHeld, subscribeToRunHolds } from '../../lib/tool-run-hold';

/**
 * Whether a Tool's designated run has ended with its Session alive
 * (`docs/specs/dor-tool.md` -> Run end): its shell is back at a prompt after a
 * finished run of the designated command — or after any command, once a host
 * replacement lapsed — and the host is not replacing that run. A Tool booting,
 * awaiting approval, or taking over its caller has finished no such run; a
 * reaped or stopping one has no live shell to return.
 */
export function toolRunEnded(id: string, params: unknown): boolean {
  if (!isToolParams(params) || params.toolPending !== undefined) return false;
  if (isToolReaped(id) || isToolStopping(id) || isRunHeld(id)) return false;
  if (registry.get(id)?.exited) return false;
  const { currentCommand, lastCommand } = getTerminalPaneState(id);
  return currentCommand === null && lastCommand !== null && (isHoldLapsed(id) || lastCommand.rawCommandLine === params.command);
}

/** The Tool becomes the plain terminal it runs in, in place: same Session,
 *  ref, scrollback, and rename; its browser, announcements, unsaved state,
 *  and any preview mark go with the designation. */
export function endToolDesignation(lath: LathWallEngine, id: string): void {
  const meta = lath.getMeta(id);
  if (!meta) return;
  retireToolRun(lath, id);
  lath.store.setMeta(id, becomeTerminalMeta(meta, getTerminalPaneState(id).titleCandidates.user?.title ?? null));
}

/** Ends each of this Wall's Tools whose run ended, as its shell reports it or
 *  as a host hold lapses. Paused while the Workspace closes or transfers; the
 *  destination Wall checks again on mount. */
export function useToolRunEnd({ lath, doorsRef, paused }: {
  lath: LathWallEngine;
  doorsRef: React.MutableRefObject<DooredItem[]>;
  paused: () => boolean;
}): void {
  useEffect(() => {
    const check = (changed?: string) => {
      if (paused()) return;
      for (const leaf of toolLeaves(lath, doorsRef.current)) {
        if (changed !== undefined && leaf.id !== changed) continue;
        // The successor the host gave up on came after all.
        if (getTerminalPaneState(leaf.id).currentCommand?.rawCommandLine === leaf.params.command) clearHoldLapse(leaf.id);
        if (!toolRunEnded(leaf.id, leaf.params)) continue;
        clearHoldLapse(leaf.id);
        endToolDesignation(lath, leaf.id);
      }
    };
    const unsubscribeState = subscribeToTerminalPaneState(check);
    const unsubscribeHolds = subscribeToRunHolds(check);
    check();
    return () => { unsubscribeState(); unsubscribeHolds(); };
  }, [lath, doorsRef, paused]);
}

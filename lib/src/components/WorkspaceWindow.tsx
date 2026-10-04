import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { WorkspaceMotion } from './WorkspaceMotion';
import { Wall } from './Wall';
import { listWallHandles } from './wall/wall-handles';
import { getWorkspaceBootPlan, seedWorkspaceBootPlans } from './wall/workspace-boot-plans';
import { getPlatform } from '../lib/platform';
import { getWorkspacesSnapshot, subscribeToWorkspaces } from '../lib/workspace-store';
import type { SessionFlushRequest } from '../lib/platform/types';
import { installWorkspaceAutoNaming } from '../lib/workspace-autoname-controller';
import type { WallBootPlans, WallBootProps } from './wall/wall-types';
import type { WorkspaceId } from '../lib/session-types';
import { RingHandoffContext } from './wall/wall-context';
import type { RingFrame } from '../lib/rect-tween';
import { PendingKillOverlay } from './PendingKillOverlay';
import { getHeldWorkspaces, subscribeToHeldWorkspaces } from './wall/workspace-lifecycle';

/**
 * One Window's Workspaces: a mounted `<Wall>` each, all in the same grid cell so
 * a switch never changes a Wall's box and the reattach fit finds the same grid
 * (docs/specs/layout.md → "Workspaces"). Switching flips which Wall is `active`;
 * nothing re-seeds, re-parents, or unmounts a leaf — only a hidden Wall's
 * terminal elements detach, as minimize does, so they hold no GL context.
 */
export function WorkspaceWindow({
  baseboardNotice,
  dialogHost,
  enableBurrow,
  initialPlans,
  ...boot
}: WallBootProps & {
  baseboardNotice?: ReactNode;
  dialogHost?: ReactNode;
  enableBurrow?: boolean;
  /** One record per Workspace, from the restored Window. Takes precedence over
   *  the single-record props, which stay for the compositions that restore one
   *  Session (stories, the website playground). */
  initialPlans?: WallBootPlans;
}) {
  const { workspaces, activeId } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  // A pending or finalizing Workspace is off the strip but keeps its Wall.
  const held = useSyncExternalStore(subscribeToHeldWorkspaces, getHeldWorkspaces);
  // Mounted in the order each first appeared, never strip order: the active
  // Wall stacks on top regardless, and moving a Wall's DOM would reload every
  // iframe in it — a pending Workspace leaving the strip and coming back, or a
  // reorder.
  const mountOrder = useRef<WorkspaceId[]>([]);
  const live = new Set([...workspaces.map(workspace => workspace.id), ...held]);
  mountOrder.current = [...mountOrder.current.filter(id => live.has(id)), ...[...live].filter(id => !mountOrder.current.includes(id))];
  const mounted = mountOrder.current;
  const ringHandoff = useRef<RingFrame | null>(null);
  // One shape for both callers, fixed at first render: without per-Workspace
  // plans the single boot record belongs to the Workspace that was active then.
  // Every later read — including a Workspace arriving from another Window, which
  // parks its own plan before it is created — goes to the same store, so a
  // Workspace that leaves and comes back mounts from the record it brought.
  // A Workspace with no entry takes Lath's fresh branch and spawns exactly one
  // default-shell pane.
  seedWorkspaceBootPlans(initialPlans ?? { [activeId]: boot });

  // The Window, not each Wall, answers the host's flush request: the adapter
  // completes on the FIRST notification, so a per-Wall answer would let a quit
  // proceed once one Workspace had written.
  useEffect(() => {
    const platform = getPlatform();
    const handleFlushRequest = (detail: SessionFlushRequest) => {
      const options = { probeCwd: detail.probeCwd };
      void Promise.all(listWallHandles().map((handle) => handle.flushPersistence(options).catch(() => undefined)))
        .finally(() => platform.notifySessionFlushComplete(detail.requestId));
    };
    platform.onRequestSessionFlush(handleFlushRequest);
    return () => platform.offRequestSessionFlush(handleFlushRequest);
  }, []);

  useEffect(() => {
    const platform = getPlatform();
    const home = platform.terminalContext?.({ op: 'settings' }).then((settings) => settings.home);
    return installWorkspaceAutoNaming(platform.gitInfo?.bind(platform), home);
  }, []);

  return (
    // One grid cell holds every Wall, so each keeps the same box whether or not
    // it is the visible one. The strip anchors its close confirmation here, not on
    // its tab: ModalOverlay centers in its target's box without clamping to the
    // viewport, so a tab-anchored dialog was clipped at the top of the window.
    <RingHandoffContext.Provider value={ringHandoff}>
      <div
        data-workspace-content
        className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden bg-app-bg"
      >
        {mounted.map((workspaceId) => {
          const isActive = workspaceId === activeId;
          const plan = getWorkspaceBootPlan(workspaceId);
          return (
            <WorkspaceMotion
              key={workspaceId}
              id={workspaceId}
              active={isActive}
            >
              <Wall
                {...plan}
                workspaceId={workspaceId}
                active={isActive}
                baseboardNotice={isActive ? baseboardNotice : undefined}
                dialogHost={isActive ? dialogHost : undefined}
                enableBurrow={enableBurrow}
              />
            </WorkspaceMotion>
          );
        })}
      </div>
      <PendingKillOverlay />
    </RingHandoffContext.Provider>
  );
}

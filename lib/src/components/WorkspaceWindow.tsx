import { useEffect, useSyncExternalStore, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Wall } from './Wall';
import { listWallHandles } from './wall/wall-handles';
import { getWorkspaceBootPlan, seedWorkspaceBootPlans } from './wall/workspace-boot-plans';
import { getPlatform } from '../lib/platform';
import { getWorkspacesSnapshot, subscribeToWorkspaces } from '../lib/workspace-store';
import type { SessionFlushRequest } from '../lib/platform/types';
import type { WallBootPlans, WallBootProps } from './wall/wall-types';

/**
 * One Window's Workspaces: a mounted `<Wall>` each, all in the same grid cell so
 * a switch never changes a Wall's box and no xterm refits
 * (docs/specs/layout.md → "Workspaces"). Switching flips which Wall is `active`;
 * nothing re-seeds, re-parents, or unmounts.
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

  return (
    // One grid cell holds every Wall, so each keeps the same box whether or not
    // it is the visible one. The strip anchors its close confirmation here.
    <div
      data-workspace-content
      className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1 overflow-hidden"
    >
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId;
        const plan = getWorkspaceBootPlan(workspace.id);
        return (
          <div
            key={workspace.id}
            data-workspace-wall={workspace.id}
            data-workspace-active={isActive ? 'true' : 'false'}
            // `visibility: hidden` (not `display: none`) keeps the box laid out,
            // so a hidden Workspace's xterms never refit. `inert` is
            // defense-in-depth: `visibility: hidden` already removes focusability.
            inert={!isActive}
            className={clsx(
              'col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col',
              !isActive && 'invisible pointer-events-none',
            )}
          >
            <Wall
              {...plan}
              workspaceId={workspace.id}
              active={isActive}
              baseboardNotice={isActive ? baseboardNotice : undefined}
              dialogHost={isActive ? dialogHost : undefined}
              enableBurrow={enableBurrow}
            />
          </div>
        );
      })}
    </div>
  );
}

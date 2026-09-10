import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react';
import { clsx } from 'clsx';
import { Wall } from './Wall';
import { listWallHandles } from './wall/wall-handles';
import { getPlatform } from '../lib/platform';
import { getWorkspacesSnapshot, subscribeToWorkspaces } from '../lib/workspace-store';
import type { WallBootProps } from './wall/wall-types';

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
  ...boot
}: WallBootProps & {
  baseboardNotice?: ReactNode;
  dialogHost?: ReactNode;
  enableBurrow?: boolean;
}) {
  const { workspaces, activeId } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  // The boot record belongs to the Workspace that was active at first render.
  // Every Workspace created later gets no boot props, so its Wall takes Lath's
  // fresh branch and spawns exactly one default-shell pane.
  const bootWorkspaceIdRef = useRef(activeId);

  // The Window, not each Wall, answers the host's flush request: the adapter
  // completes on the FIRST notification, so a per-Wall answer would let a quit
  // proceed once one Workspace had written.
  useEffect(() => {
    const platform = getPlatform();
    const handleFlushRequest = (detail: { requestId: string }) => {
      void Promise.all(listWallHandles().map((handle) => handle.flushPersistence().catch(() => undefined)))
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
        const isBoot = workspace.id === bootWorkspaceIdRef.current;
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
              {...(isBoot ? boot : {})}
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

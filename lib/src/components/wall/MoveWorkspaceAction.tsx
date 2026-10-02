import { useContext, useSyncExternalStore } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { SUBTLE_ACTION_REST_COLOR_CLASS, SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS } from '../design';
import type { WorkspaceId } from '../../lib/session-types';
import { getWorkspacesSnapshot, subscribeToWorkspaces, workspaceRefFor } from '../../lib/workspace-store';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from '../../lib/workspace-surfaces';
import { WindowFocusedContext } from './wall-context';
import { requestSurfaceMove, surfaceMoveRefusal } from './surface-move';
import { getWallHandle } from './wall-handles';
import { ACTION_BOX_CLASS, closedSelectKeyDown } from './TerminalContextView';

/** Native picker matches the context's browser actions and escapes its clipping. */
export function MoveWorkspaceAction({ id, sourceId }: { id: string; sourceId: WorkspaceId }) {
  const { workspaces } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  // Membership decides whether New workspace is offered.
  useSyncExternalStore(subscribeToWorkspaceSurfaces, getWorkspaceSurfacesSnapshot);
  const source = getWallHandle(sourceId);
  const refusal = (destination: { workspace: WorkspaceId } | { new: true }) => surfaceMoveRefusal(source, destination) ?? undefined;
  const newRefusal = refusal({ new: true });
  const focused = useContext(WindowFocusedContext);
  return <span className={`relative ${ACTION_BOX_CLASS} ${SUBTLE_ACTION_REST_COLOR_CLASS} ${focused ? SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS : ''}`}>
    move to workspace…<CaretDownIcon size={10} weight="fill" />
    <select aria-label="Move to workspace" title="Move to workspace" value="" className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      onKeyDown={closedSelectKeyDown}
      onChange={event => {
        if (event.target.value === '+') requestSurfaceMove(id, { new: true });
        else if (event.target.value) requestSurfaceMove(id, { workspace: event.target.value });
      }}>
      <option value="">move to workspace…</option>
      {workspaces.filter(workspace => workspace.id !== sourceId).map(workspace => {
        const why = refusal({ workspace: workspace.id });
        return <option key={workspace.id} value={workspace.id} disabled={!!why} title={why}>{workspaceRefFor(workspace.id)} — {workspace.name}</option>;
      })}
      <option value="+" disabled={!!newRefusal} title={newRefusal}>New workspace</option>
    </select>
  </span>;
}

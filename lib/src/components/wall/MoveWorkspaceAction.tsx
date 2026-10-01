import { useContext, useSyncExternalStore } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { SUBTLE_ACTION_REST_COLOR_CLASS, SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS } from '../design';
import type { WorkspaceId } from '../../lib/session-types';
import { getWorkspacesSnapshot, subscribeToWorkspaces, workspaceRefFor } from '../../lib/workspace-store';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from '../../lib/workspace-surfaces';
import { WindowFocusedContext } from './wall-context';
import { requestSurfaceMove } from './surface-move';
import { ACTION_BOX_CLASS, closedSelectKeyDown } from './TerminalContextView';

/** Native picker matches the context's browser actions and escapes its clipping. */
export function MoveWorkspaceAction({ id, sourceId }: { id: string; sourceId: WorkspaceId }) {
  const { workspaces } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  const members = useSyncExternalStore(subscribeToWorkspaceSurfaces, getWorkspaceSurfacesSnapshot);
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
      {workspaces.filter(workspace => workspace.id !== sourceId).map(workspace => <option key={workspace.id} value={workspace.id}>{workspaceRefFor(workspace.id)} — {workspace.name}</option>)}
      <option value="+" disabled={(members.get(sourceId)?.length ?? 0) <= 1}>New workspace</option>
    </select>
  </span>;
}

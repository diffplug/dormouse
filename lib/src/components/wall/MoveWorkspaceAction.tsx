import { useContext, useSyncExternalStore } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { SUBTLE_ACTION_REST_COLOR_CLASS, SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS } from '../design';
import { getWorkspacesSnapshot, subscribeToWorkspaces, workspaceRefFor } from '../../lib/workspace-store';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from '../../lib/workspace-surfaces';
import { WindowFocusedContext } from './wall-context';
import { wallHandleOwning } from './wall-handles';
import { requestSurfaceMove } from './surface-move';

/** Native picker matches the context's browser actions and escapes its clipping. */
export function MoveWorkspaceAction({ id }: { id: string }) {
  const { workspaces } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  const members = useSyncExternalStore(subscribeToWorkspaceSurfaces, getWorkspaceSurfacesSnapshot);
  const focused = useContext(WindowFocusedContext);
  const source = wallHandleOwning(id);
  if (!source?.canMoveSurfaces) return null;
  return <span className={`relative inline-flex h-6 shrink-0 items-center gap-1.5 whitespace-nowrap rounded px-1.5 ${SUBTLE_ACTION_REST_COLOR_CLASS} ${focused ? SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS : ''}`}>
    move to workspace…<CaretDownIcon size={10} weight="fill" />
    <select aria-label="Move to workspace" title="Move to workspace" value="" className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      onKeyDown={event => {
        if (['Enter', ' ', 'Tab', 'Escape', 'F4'].includes(event.key) || event.altKey || event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          try { event.currentTarget.showPicker(); } catch { /* Space and Alt+↓ still open it. */ }
        }
      }}
      onChange={event => {
        if (event.target.value === '+') requestSurfaceMove(id, { new: true });
        else if (event.target.value) requestSurfaceMove(id, { workspace: event.target.value });
      }}>
      <option value="">move to workspace…</option>
      {workspaces.filter(workspace => workspace.id !== source.workspaceId).map(workspace => <option key={workspace.id} value={workspace.id}>{workspaceRefFor(workspace.id)} — {workspace.name}</option>)}
      <option value="+" disabled={(members.get(source.workspaceId)?.length ?? 0) <= 1}>New workspace</option>
    </select>
  </span>;
}

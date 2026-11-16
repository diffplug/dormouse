import { useContext, useSyncExternalStore } from 'react';
import { CaretDownIcon } from '@phosphor-icons/react';
import { SUBTLE_ACTION_REST_COLOR_CLASS, SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS } from '../design';
import type { WorkspaceId } from '../../lib/session-types';
import { getWorkspacesSnapshot, subscribeToWorkspaces } from '../../lib/workspace-store';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from '../../lib/workspace-surfaces';
import { getOtherWindowWorkspaces, subscribeToOtherWindowWorkspaces } from '../../lib/other-window-workspaces';
import { WindowFocusedContext } from './wall-context';
import { requestSurfaceMove, requestSurfaceMoveToWindow, surfaceMoveRefusal } from './surface-move';
import { getWallHandle } from './wall-handles';
import { ACTION_BOX_CLASS, closedSelectKeyDown } from './TerminalContextView';
import { CONTEXT_KEYS, contextKey, KeyHint } from './context-keys';

/** Native picker matches the context's browser actions and escapes its clipping.
 *  With other Windows open, each Window's Workspaces sit under its own header. */
export function MoveWorkspaceAction({ id, sourceId }: { id: string; sourceId: WorkspaceId }) {
  const { workspaces } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  const otherWindows = useSyncExternalStore(subscribeToOtherWindowWorkspaces, getOtherWindowWorkspaces);
  // Membership decides whether New workspace is offered.
  useSyncExternalStore(subscribeToWorkspaceSurfaces, getWorkspaceSurfacesSnapshot);
  const source = getWallHandle(sourceId);
  const refusal = (destination: { workspace: WorkspaceId } | { new: true }) => surfaceMoveRefusal(source, destination) ?? undefined;
  const newRefusal = refusal({ new: true });
  const elsewhereRefusal = surfaceMoveRefusal(source, { new: true }, true) ?? undefined;
  const focused = useContext(WindowFocusedContext);
  const here = <>
    {workspaces.filter(workspace => workspace.id !== sourceId).map(workspace => {
      const why = refusal({ workspace: workspace.id });
      return <option key={workspace.id} value={workspace.id} disabled={!!why} title={why}>{workspace.id} — {workspace.name}</option>;
    })}
    <option value="+" disabled={!!newRefusal} title={newRefusal}>New workspace</option>
  </>;
  return <span className={`relative ${ACTION_BOX_CLASS} ${SUBTLE_ACTION_REST_COLOR_CLASS} ${focused ? SUBTLE_ACTION_WRAPPER_INTERACTION_CLASS : ''}`}>
    move to workspace…<CaretDownIcon size={10} weight="fill" /><KeyHint k={CONTEXT_KEYS.move} />
    <select aria-label="Move to workspace" title="Move to workspace" {...contextKey(CONTEXT_KEYS.move)} value="" className="absolute inset-0 cursor-pointer appearance-none opacity-0"
      onKeyDown={closedSelectKeyDown}
      onChange={event => {
        const value = event.target.value;
        // Another Window's option is `<label> <workspace id>`; neither holds a space.
        const space = value.indexOf(' ');
        if (space > 0) requestSurfaceMoveToWindow(id, value.slice(0, space), value.slice(space + 1));
        else if (value === '+') requestSurfaceMove(id, { new: true });
        else if (value) requestSurfaceMove(id, { workspace: value });
      }}>
      <option value="">move to workspace…</option>
      {otherWindows.length === 0 ? here : <>
        <optgroup label="This window">{here}</optgroup>
        {otherWindows.map(other => <optgroup key={other.window} label={`window:${other.window}`}>
          {other.workspaces.map(workspace => <option key={workspace.id} value={`${other.window} ${workspace.id}`} disabled={!!elsewhereRefusal} title={elsewhereRefusal}>
            {workspace.id} — {workspace.name}
          </option>)}
        </optgroup>)}
      </>}
    </select>
  </span>;
}

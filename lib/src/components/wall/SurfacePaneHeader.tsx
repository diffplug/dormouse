import { useContext } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import {
  ArrowLineDownIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  FrameCornersIcon,
  ResizeIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  XIcon,
} from '@phosphor-icons/react';
import { HeaderActionButton } from '../HeaderActionButton';
import { TERMINAL_TOP_RADIUS_CLASS } from '../design';
import {
  useAgentBrowserScreenController,
  useAgentBrowserScreenSnapshot,
} from './agent-browser-screen';
import {
  ModeContext,
  SelectedIdContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedContext,
} from './wall-context';

export function SurfacePaneHeader({ api }: IDockviewPanelHeaderProps) {
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const windowFocused = useContext(WindowFocusedContext);
  const zoomed = useContext(ZoomedContext);
  const actions = useContext(WallActionsContext);
  const isActiveHeader = mode === 'passthrough' && selectedId === api.id && windowFocused;

  // Presence of a screen controller for this pane is exactly what marks it an
  // agent-browser surface — terminals/iframes never register one, so the chip
  // is strictly scoped to browser surfaces.
  const screen = useAgentBrowserScreenController(api.id);
  const screenSnapshot = useAgentBrowserScreenSnapshot(screen);

  return (
    <div
      className={`flex h-full w-full cursor-grab items-center gap-1.5 ${TERMINAL_TOP_RADIUS_CLASS} pl-2 pr-[5px] text-sm leading-none font-mono select-none active:cursor-grabbing ${isActiveHeader ? 'bg-header-active-bg text-header-active-fg' : 'bg-header-inactive-bg text-header-inactive-fg'}`}
      onMouseDown={() => actions.onClickPanel(api.id)}
    >
      <span className="min-w-0 flex-1 truncate font-medium">{api.title ?? api.id}</span>
      {screen && screenSnapshot && (
        <button
          type="button"
          onClick={(e) => { e.stopPropagation(); screen.actions.openModal(); }}
          aria-label={`Screen: ${screenSnapshot.state} — change viewport`}
          title={`Screen: ${screenSnapshot.state} — change viewport`}
          className="flex h-5 min-w-5 shrink-0 items-center justify-center rounded text-current/70 transition-colors hover:bg-current/10 hover:text-current"
        >
          {screenSnapshot.state === 'SYNCED'
            ? <FrameCornersIcon size={14} />
            : <ResizeIcon size={14} />}
        </button>
      )}
      <div className="ml-1 hidden shrink-0 items-center gap-0.5 min-[420px]:flex">
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onSplitH(api.id); }}
          ariaLabel="Split left/right"
          tooltip="Split left/right [|] or [%]"
        ><SplitHorizontalIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onSplitV(api.id); }}
          ariaLabel="Split top/bottom"
          tooltip={'Split top/bottom [-] or ["]'}
        ><SplitVerticalIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onZoom(api.id); }}
          ariaLabel={zoomed ? 'Unzoom' : 'Zoom'}
          tooltip={zoomed ? 'Unzoom [z]' : 'Zoom [z]'}
        >{zoomed ? <ArrowsInIcon size={14} /> : <ArrowsOutIcon size={14} />}</HeaderActionButton>
      </div>
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={(e) => { e.stopPropagation(); actions.onMinimize(api.id); }}
          ariaLabel="Minimize"
          tooltip="Minimize [m] or [d]"
        ><ArrowLineDownIcon size={14} /></HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
          onClick={(e) => { e.stopPropagation(); actions.onKill(api.id); }}
          ariaLabel="Kill"
          tooltip="Kill [k] or [x]"
        ><XIcon size={14} /></HeaderActionButton>
      </div>
    </div>
  );
}

import { useContext, useRef, useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { ToolDirtyIndicator, useToolDirty } from '../ToolDirtyIndicator';
import { paneHeader, PREVIEW_LABEL_CLASS } from '../design';
import { DEFAULT_ACTIVITY_STATE, getActivitySnapshot, getTerminalPaneStateSnapshot, subscribeToActivity, subscribeToTerminalPaneState } from '../../lib/terminal-registry';
import { useAgentBrowserDisplayMode, useAgentBrowserScreenController } from './agent-browser-screen';
import { BROWSER_DISPLAY_SLOT_PX, BrowserDisplayButton } from './BrowserDisplayIcon';
import { isPreviewSlotParams } from './browser-surface';
import { HEADER_CONTROL_SLOT_PX, PaneActionGroup, SplitButtons, TerminalContextButton } from './PaneActionButtons';
import { usePreviewKeep } from './preview-keep';
import { shownToolFace, useHeldWhile, usePreviewSlotView } from './preview-transition';
import { SessionTodoPill } from './SessionTodoPill';
import { TerminalPaneHeader, terminalHeaderTier } from './TerminalPaneHeader';
import { toolSemanticName } from './tool-name';
import { useHeaderTier } from './use-header-tier';
import { usePaneRename } from './use-pane-rename';
import {
  ModeContext,
  SelectedIdContext,
  TerminalContextContext,
  WallActionsContext,
  WindowFocusedContext,
  ZoomedIdContext,
} from './wall-context';
import type { PaneProps } from './pane-props';

export function ToolPaneHeader(props: PaneProps) {
  // A preview slot switch keeps the face it holds (`docs/specs/layout.md` ->
  // Pane header), so the header neither flips nor remounts.
  const { transition } = usePreviewSlotView(props.id);
  const face = shownToolFace(props.params, transition);
  if (face === 'browser') return <ToolBrowserHeader {...props} switching={transition !== null} />;
  // The terminal face shows the terminal Terminal Context would, and pending
  // approval has none yet.
  return <TerminalPaneHeader {...props} terminalContext={face === 'port-conflict'} />;
}

type ToolHeaderTier = 'full' | 'compact' | 'minimal' | 'tiny';
/** The terminal header's boundaries, each with the leading controls it keeps
 *  reserved: splits and Display need both, minimize and kill Terminal Context
 *  alone (`docs/specs/layout.rationale.md`). */
const toolHeaderTier = (width: number): ToolHeaderTier => {
  const withDisplay = terminalHeaderTier(width - HEADER_CONTROL_SLOT_PX - BROWSER_DISPLAY_SLOT_PX);
  if (withDisplay === 'full') return 'full';
  if (withDisplay !== 'tiny') return 'compact';
  return terminalHeaderTier(width - HEADER_CONTROL_SLOT_PX) === 'tiny' ? 'tiny' : 'minimal';
};

/** A serving Tool's header: its semantic name, never a browser's navigation
 *  or address (`docs/specs/layout.md` -> Pane header). */
function ToolBrowserHeader({ id, title, params, switching }: PaneProps & { switching: boolean }) {
  const dirty = useToolDirty(id, params);
  const preview = isPreviewSlotParams(params);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const windowFocused = useContext(WindowFocusedContext);
  const zoomed = useContext(ZoomedIdContext) === id;
  const actions = useContext(WallActionsContext);
  const context = useContext(TerminalContextContext);
  const isActiveHeader = mode === 'passthrough' && selectedId === id && windowFocused;
  // The Tool's Session rings and keeps TODOs while its browser shows, so the
  // pill rides this face too (`docs/specs/layout.md` -> Pane header).
  const activity = useSyncExternalStore(subscribeToActivity, getActivitySnapshot).get(id) ?? DEFAULT_ACTIVITY_STATE;
  const userTitle = useSyncExternalStore(subscribeToTerminalPaneState, () => getTerminalPaneStateSnapshot().get(id)?.titleCandidates.user?.title ?? null);
  const name = toolSemanticName(params, userTitle) ?? title ?? id;
  const screen = useAgentBrowserScreenController(id);
  // A switch retires the browser the ghost shows, so the glyph holds too.
  const displayMode = useHeldWhile(useAgentBrowserDisplayMode(screen), switching);
  const headerRef = useRef<HTMLDivElement>(null);
  const tier = useHeaderTier(headerRef, toolHeaderTier);
  const rename = usePaneRename(id);
  const keep = usePreviewKeep(id, preview);

  return (
    <div
      ref={headerRef}
      data-pane-header-for={id}
      className={paneHeader({ state: isActiveHeader ? 'active' : 'inactive' })}
      onMouseDown={() => actions.onClickPanel(id)}
      {...keep}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        context.open(id, { origin: { x: e.clientX, y: e.clientY } });
      }}
    >
      {(tier === 'full' || tier === 'compact') && (
        <BrowserDisplayButton mode={displayMode} onOpen={screen ? () => screen.actions.openModal() : undefined} />
      )}
      <TerminalContextButton surfaceId={id} />
      <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-hidden">
        {rename.renaming ? rename.editor(name) : (
          // As on the terminal face, a preview's name is drag area, not a rename.
          <span
            data-pane-title-for={id}
            className={clsx('min-w-0 truncate font-medium', preview ? PREVIEW_LABEL_CLASS : 'cursor-text decoration-current/50 underline-offset-2 hover:underline')}
            onMouseDown={preview ? undefined : (e) => e.stopPropagation()}
            onClick={preview ? undefined : (e) => { e.stopPropagation(); actions.onStartRename(id); }}
            title={preview ? 'Preview' : undefined}
          >{name}</span>
        )}
        <SessionTodoPill id={id} activity={activity} shown={tier === 'full' || tier === 'compact'} />
      </div>
      {!rename.renaming && (
        <>
          {tier === 'full' && <SplitButtons surfaceId={id} />}
          <PaneActionGroup dirty={dirty} surfaceId={id} zoomed={zoomed} activeHeader={isActiveHeader} showMinimizeKill={tier !== 'tiny'} />
        </>
      )}
      {/* Where the tier or the rename editor hides Kill, the dot it carries sits at the right edge. */}
      {(tier === 'tiny' || rename.renaming) && <ToolDirtyIndicator dirty={dirty} />}
      {rename.warning}
    </div>
  );
}

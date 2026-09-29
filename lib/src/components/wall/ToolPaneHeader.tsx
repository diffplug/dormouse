import { useContext, useRef, useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import { ToolDirtyIndicator, useToolDirty } from '../ToolDirtyIndicator';
import { PREVIEW_LABEL_CLASS } from '../design';
import { getTerminalPaneStateSnapshot, subscribeToTerminalPaneState } from '../../lib/terminal-registry';
import { browserDisplayMode, useAgentBrowserScreenController, useAgentBrowserScreenSnapshot } from './agent-browser-screen';
import { BrowserDisplayButton } from './BrowserDisplayIcon';
import { isPreviewSlotParams } from './browser-surface';
import { PaneActionGroup, SplitButtons, TerminalContextButton } from './PaneActionButtons';
import { usePreviewKeep } from './preview-keep';
import { shownToolFace, useHeldWhile, usePreviewSlotView } from './preview-transition';
import { paneHeaderVariant, TerminalPaneHeader } from './TerminalPaneHeader';
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
  const face = shownToolFace(props.params, usePreviewSlotView(props.id).transition);
  if (face === 'browser') return <ToolBrowserHeader {...props} />;
  // The terminal face shows the terminal Terminal Context would, and pending
  // approval has none yet.
  return <TerminalPaneHeader {...props} terminalContext={face === 'port-conflict'} />;
}

type ToolHeaderTier = 'full' | 'compact' | 'minimal' | 'tiny';
// Border-box widths; `docs/specs/layout.rationale.md` derives each boundary.
const toolHeaderTier = (width: number): ToolHeaderTier =>
  width > 355 ? 'full' : width > 160 ? 'compact' : width > 124 ? 'minimal' : 'tiny';

/** A serving Tool's header: its semantic name, never a browser's navigation
 *  or address (`docs/specs/layout.md` -> Pane header). */
function ToolBrowserHeader({ id, title, params }: PaneProps) {
  const dirty = useToolDirty(id, params);
  const preview = isPreviewSlotParams(params);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const windowFocused = useContext(WindowFocusedContext);
  const zoomed = useContext(ZoomedIdContext) === id;
  const actions = useContext(WallActionsContext);
  const context = useContext(TerminalContextContext);
  const isActiveHeader = mode === 'passthrough' && selectedId === id && windowFocused;
  const userTitle = useSyncExternalStore(subscribeToTerminalPaneState, () => getTerminalPaneStateSnapshot().get(id)?.titleCandidates.user?.title ?? null);
  const name = toolSemanticName(params, userTitle) ?? title ?? id;
  const screen = useAgentBrowserScreenController(id);
  const snapshot = useAgentBrowserScreenSnapshot(screen);
  // A switch retires the browser the ghost shows, so the glyph holds too.
  const displayMode = useHeldWhile(snapshot ? browserDisplayMode(snapshot) : null, usePreviewSlotView(id).transition !== null);
  const headerRef = useRef<HTMLDivElement>(null);
  const tier = useHeaderTier(headerRef, toolHeaderTier);
  const rename = usePaneRename(id);
  const keep = usePreviewKeep(id, preview);

  return (
    <div
      ref={headerRef}
      data-pane-header-for={id}
      className={paneHeaderVariant({ state: isActiveHeader ? 'active' : 'inactive' })}
      onMouseDown={() => actions.onClickPanel(id)}
      {...keep}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        context.open(id, { origin: { x: e.clientX, y: e.clientY } });
      }}
    >
      <ToolDirtyIndicator dirty={dirty} />
      {(tier === 'full' || tier === 'compact') && (
        <BrowserDisplayButton mode={displayMode} onOpen={screen ? () => screen.actions.openModal() : undefined} />
      )}
      <TerminalContextButton surfaceId={id} />
      <div className="flex min-w-0 flex-1 items-center overflow-hidden">
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
      </div>
      {!rename.renaming && (
        <>
          {tier === 'full' && <SplitButtons surfaceId={id} />}
          <PaneActionGroup surfaceId={id} zoomed={zoomed} activeHeader={isActiveHeader} showMinimizeKill={tier !== 'tiny'} />
        </>
      )}
      {rename.warning}
    </div>
  );
}

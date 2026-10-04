import { isHelperSession } from '../../lib/terminal-store';
import { useContext, useMemo, useRef, useSyncExternalStore } from 'react';
import { clsx } from 'clsx';
import {
  CursorClickIcon,
  CursorTextIcon,
} from '@phosphor-icons/react';
import { ToolDirtyIndicator, useToolDirty } from '../ToolDirtyIndicator';
import { HeaderActionButton } from '../HeaderActionButton';
import { paneHeader, PREVIEW_LABEL_CLASS } from '../design';
import { isPreviewSlotParams } from './browser-surface';
import { usePreviewKeep } from './preview-keep';
import { SessionTodoPill } from './SessionTodoPill';
import { useHeaderTier } from './use-header-tier';
import { HEADER_CONTROL_SLOT_PX, PaneActionGroup, SplitButtons, TerminalContextButton } from './PaneActionButtons';
import type { PaneProps } from './pane-props';
import { toolSemanticName } from './tool-name';
import { usePaneRename } from './use-pane-rename';
import {
  getMouseSelectionState,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from '../../lib/mouse-selection';
import {
  DEFAULT_ACTIVITY_STATE,
  getActivitySnapshot,
  getTerminalPaneStateSnapshot,
  subscribeToActivity,
  subscribeToTerminalPaneState,
} from '../../lib/terminal-registry';
import {
  buildAppTitleResolver,
  createTerminalPaneState,
  COMMAND_FAIL_GLYPH,
  deriveHeader,
  resolveDisplayPrimary,
} from '../../lib/terminal-state';
import { useHeldWhile, usePreviewSlotView } from './preview-transition';
import {
  TerminalContextContext,
  ModeContext,
  WallActionsContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedIdContext,
} from './wall-context';

type TerminalHeaderTier = 'full' | 'compact' | 'minimal' | 'tiny';
// Border-box widths, so they include the header's 8px left + 5px right padding
// (`docs/specs/layout.rationale.md` derives each boundary). Measuring the
// border box also tells a narrow header from a hidden one.
export const terminalHeaderTier = (width: number): TerminalHeaderTier =>
  width > 293 ? 'full'
    : width > 173 ? 'compact'
      : width > 98 ? 'minimal'
        : 'tiny';

export function TerminalPaneHeader({ id, title, params, terminalContext = false }: PaneProps & {
  /** Lead with the Tool's Terminal Context button (`ToolPaneHeader`). */
  terminalContext?: boolean;
}) {
  const dirty = useToolDirty(id, params);
  const preview = isPreviewSlotParams(params);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const zoomed = useContext(ZoomedIdContext) === id;
  const windowFocused = useContext(WindowFocusedContext);
  const context = useContext(TerminalContextContext);
  const activityStates = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const terminalStates = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot);
  // Primitive selectors, never the store's map: it is replaced on every drag
  // and hover update, so a whole-map subscription would rerender every header
  // (docs/specs/mouse-and-clipboard.md §7).
  const showMouseIcon = useSyncExternalStore(
    subscribeToMouseSelection, () => getMouseSelectionState(id).mouseReporting !== 'none',
  );
  const mouseOverride = useSyncExternalStore(
    subscribeToMouseSelection, () => getMouseSelectionState(id).override,
  );
  const actions = useContext(WallActionsContext);
  const activity = activityStates.get(id) ?? DEFAULT_ACTIVITY_STATE;
  const paneState = terminalStates.get(id) ?? createTerminalPaneState();
  const allPaneStates = useMemo(() => [...terminalStates].filter(([surfaceId]) => !isHelperSession(surfaceId)).map(([, state]) => state), [terminalStates]);
  const visiblePaneStates = allPaneStates.length > 0 ? allPaneStates : [paneState];
  const appTitleForPane = useMemo(
    () => buildAppTitleResolver(terminalStates, activityStates),
    [terminalStates, activityStates],
  );
  const derivedHeader = deriveHeader(paneState, visiblePaneStates, { appTitleForPane });
  const displayTitle = resolveDisplayPrimary(derivedHeader.primary, title);
  // The failure glyph rides at the end of the title string (so tabs/OS titles
  // carry it too). `lastCommandFailed` tells us authoritatively that it's there,
  // so we can color it red and strip it from the editing/rename base without
  // guessing from the string (a user title ending in "✗" would fool a match).
  const showsFailGlyph = derivedHeader.lastCommandFailed === true;
  // A preview slot switch on this face holds the label it showed, then, once
  // a retarget commits a new generation, the Tool's name
  // (`docs/specs/layout.md` -> Pane header).
  const { generation, transition } = usePreviewSlotView(id);
  const holding = transition?.ghost.kind === 'terminal';
  const held = useHeldWhile({
    generation,
    label: {
      primary: showsFailGlyph ? displayTitle.slice(0, -` ${COMMAND_FAIL_GLYPH}`.length) : displayTitle,
      secondary: derivedHeader.secondary ?? null,
      failed: showsFailGlyph,
    },
  }, holding);
  const retargeted = held.generation !== generation ? toolSemanticName(params, paneState.titleCandidates.user?.title) : null;
  const label = retargeted !== null ? { primary: retargeted, secondary: null, failed: false } : held.label;
  const inOverride = mouseOverride !== 'off';
  const mouseIconTooltip: string | null = mouseOverride === 'permanent'
    ? "You're overriding the TUI's mouse capture. Click to restore."
    : mouseOverride === 'temporary'
      ? null
      : 'TUI is intercepting mouse commands. Click to override.';
  const mouseIconAriaLabel = inOverride ? 'Restore mouse capture' : 'Override mouse capture';
  const isSelected = selectedId === id;
  const isActiveHeader = mode === 'passthrough' && isSelected && windowFocused;
  const rename = usePaneRename(id);
  const tabRef = useRef<HTMLDivElement>(null);
  const tier = useHeaderTier(tabRef, terminalHeaderTier, { reservePx: terminalContext ? HEADER_CONTROL_SLOT_PX : 0 });
  const compactOrWider = tier === 'full' || tier === 'compact';
  const tiny = tier === 'tiny';
  const keep = usePreviewKeep(id, preview);

  return (
    <div
      ref={tabRef}
      data-pane-header-for={id}
      className={paneHeader({ state: isActiveHeader ? 'active' : 'inactive' })}
      onMouseDown={() => actions.onClickPanel(id)}
      {...keep}
      onContextMenu={(e) => {
        // The whole header is the terminal context's entry point; `[a]` opens
        // the same menu anchored here (`docs/specs/alert.md` -> Pane Header).
        e.preventDefault();
        e.stopPropagation();
        context.open(id, { origin: { x: e.clientX, y: e.clientY } });
      }}
    >
      {terminalContext && <TerminalContextButton surfaceId={id} />}
      <div className="flex flex-1 min-w-0 items-center gap-1.5 overflow-hidden">
        {rename.renaming ? rename.editor(label.primary) : (
          // A preview's label is drag area, not a rename: its double-click
          // keeps the slot (`docs/specs/layout.md` -> Pane header).
          <span
            data-pane-title-for={id}
            className={clsx('inline-flex max-w-full min-w-0 shrink items-baseline overflow-hidden font-medium text-inherit', !preview && 'cursor-text decoration-current/50 underline-offset-2 hover:underline')}
            onMouseDown={preview ? undefined : (e) => e.stopPropagation()}
            onClick={preview ? undefined : (e) => { e.stopPropagation(); actions.onStartRename(id); }}
            title={preview ? 'Preview' : undefined}
          >
            <span className={clsx('min-w-0 shrink truncate', preview && PREVIEW_LABEL_CLASS)}>{label.primary}</span>
            {label.failed && (
              <span className="ml-1 shrink-0 text-error" aria-label="last command failed">{COMMAND_FAIL_GLYPH}</span>
            )}
            {label.secondary && (
              <span className="ml-1 min-w-0 shrink truncate opacity-70">{label.secondary}</span>
            )}
          </span>
        )}
        <SessionTodoPill id={id} activity={activity} shown={compactOrWider} />
      </div>
      {!rename.renaming && (
        <>
          {showMouseIcon && compactOrWider && (
            <div className="ml-1 shrink-0">
              <HeaderActionButton
                className="flex h-5 min-w-5 items-center justify-center rounded transition-colors shrink-0 hover:bg-current/10"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setMouseOverride(id, inOverride ? 'off' : 'temporary');
                }}
                ariaLabel={mouseIconAriaLabel}
                tooltip={mouseIconTooltip}
              >
                <span className="relative flex items-center justify-center">
                  {inOverride ? (
                    <CursorTextIcon size={14} />
                  ) : (
                    <CursorClickIcon size={14} />
                  )}
                </span>
              </HeaderActionButton>
            </div>
          )}
          {tier === 'full' && <SplitButtons surfaceId={id} />}
          {/* The title region clips via `overflow-hidden` so this group
              never has to (`docs/specs/layout.md` → "Pane header responsive
              sizing"). */}
          <PaneActionGroup dirty={dirty} surfaceId={id} zoomed={zoomed} activeHeader={isActiveHeader} showMinimizeKill={!tiny} />
        </>
      )}
      {/* Where the tier or the rename editor hides Kill, the dot it carries sits at the right edge. */}
      {(tiny || rename.renaming) && <ToolDirtyIndicator dirty={dirty} />}
      {rename.warning}
    </div>
  );
}

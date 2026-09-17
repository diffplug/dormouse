import { isHelperSession } from '../../lib/terminal-store';
import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { tv } from 'tailwind-variants';
import {
  ArrowLineDownIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  CursorClickIcon,
  CursorTextIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  XIcon,
} from '@phosphor-icons/react';
import { ToolDirtyIndicator, useToolDirty } from '../ToolDirtyIndicator';
import { HeaderActionButton } from '../HeaderActionButton';
import { HEADER_PALETTE_TRANSITION_CLASS, paneZoomButtonClass, POPUP_SURFACE_CLASS, TERMINAL_TOP_RADIUS_CLASS, TODO_PILL_TRACKING_CLASS } from '../design';
import { AlertBell } from '../AlertBell';
import { useTodoPillContent } from '../TodoPillBody';
import { useHeaderTier } from './use-header-tier';
import { NotepadHeaderButton } from './NotepadHeaderButton';
import type { PaneProps } from './pane-props';
import { IllegalRenameWarning, type RenameRejection } from './IllegalRenameWarning';
import { InlineEditInput } from './InlineEditInput';
import {
  getMouseSelectionState,
  setOverride as setMouseOverride,
  subscribeToMouseSelection,
} from '../../lib/mouse-selection';
import {
  clearSessionTodo,
  DEFAULT_ACTIVITY_STATE,
  getActivitySnapshot,
  getTerminalPaneStateSnapshot,
  subscribeToActivity,
  subscribeToTerminalPaneState,
  type SessionStatus,
} from '../../lib/terminal-registry';
import {
  buildAppTitleResolver,
  commandArgv0,
  createTerminalPaneState,
  COMMAND_FAIL_GLYPH,
  deriveHeader,
  resolveDisplayPrimary,
} from '../../lib/terminal-state';
import {
  TerminalContextContext,
  ModeContext,
  WallActionsContext,
  RenamingIdContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedIdContext,
} from './wall-context';

const tabVariant = tv({
  // The active/inactive palette swap crossfades in step with the focus ring's
  // travel (HEADER_PALETTE_TRANSITION_CLASS); children inherit via `text-inherit`.
  base: `flex h-full min-w-0 flex-1 cursor-grab items-center gap-1.5 ${TERMINAL_TOP_RADIUS_CLASS} pl-2 pr-[5px] text-sm leading-none font-mono select-none active:cursor-grabbing ${HEADER_PALETTE_TRANSITION_CLASS}`,
  variants: {
    state: {
      active: 'bg-header-active-bg text-header-active-fg',
      inactive: 'bg-header-inactive-bg text-header-inactive-fg',
    },
  },
});

type TerminalHeaderTier = 'full' | 'compact' | 'minimal' | 'tiny';
// Includes the header's 8px left + 5px right padding; the former content-box
// boundaries were 280/160px. Border-box width distinguishes tiny from hidden.
// 81px is where the 3-button pane-action group stops fitting beside that
// padding (4px offset + 3x20px + 2x2px gaps).
const terminalHeaderTier = (width: number): TerminalHeaderTier =>
  width > 293 ? 'full' : width > 173 ? 'compact' : width > 80 ? 'minimal' : 'tiny';

// WATCHING is a rule on the running command, so the bell says which command it
// would act on rather than naming an abstract toggle (`docs/specs/alert.md`).
function alertButtonLabelsFor(status: SessionStatus, argv0: string | null): { aria: string; tooltip: string } {
  if (status === 'ALERT_RINGING') return { aria: 'Alert ringing', tooltip: 'Alert ringing' };
  if (status === 'OSC_NOTIF_BUSY') return { aria: 'Progress active', tooltip: 'Progress active' };
  if (status === 'COMMAND_EXIT_ARMED') return { aria: 'Command running', tooltip: 'Command running' };
  if (!argv0) return { aria: 'Alerts are per command', tooltip: '[a] Alerts are per command' };
  return status === 'WATCHING_DISABLED'
    ? { aria: `Alert on all ${argv0}`, tooltip: `[a] Alert on all "${argv0}"` }
    : { aria: `Stop alerting on all ${argv0}`, tooltip: `[a] Stop alerting on all "${argv0}"` };
}
const TODO_PREVIEW_GAP = 6;
const TODO_PREVIEW_MARGIN = 8;

export function TerminalPaneHeader({ id, title, params }: PaneProps) {
  const dirty = useToolDirty(id, params);
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const renamingId = useContext(RenamingIdContext);
  const zoomed = useContext(ZoomedIdContext) === id;
  const windowFocused = useContext(WindowFocusedContext);
  const context = useContext(TerminalContextContext);
  const activityStates = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const terminalStates = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot);
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
  const displayTitleBase = showsFailGlyph
    ? displayTitle.slice(0, -` ${COMMAND_FAIL_GLYPH}`.length)
    : displayTitle;
  const inOverride = mouseOverride !== 'off';
  const mouseIconTooltip: string | null = mouseOverride === 'permanent'
    ? "You're overriding the TUI's mouse capture. Click to restore."
    : mouseOverride === 'temporary'
      ? null
      : 'TUI is intercepting mouse commands. Click to override.';
  const mouseIconAriaLabel = inOverride ? 'Restore mouse capture' : 'Override mouse capture';
  const isSelected = selectedId === id;
  const isActiveHeader = mode === 'passthrough' && isSelected && windowFocused;
  const isRenaming = renamingId === id;
  const tabRef = useRef<HTMLDivElement>(null);
  const suppressAlertClickRef = useRef(false);
  const tier = useHeaderTier(tabRef, terminalHeaderTier);
  const [todoPreviewRect, setTodoPreviewRect] = useState<DOMRect | null>(null);
  const [renameWarning, setRenameWarning] = useState<{ rect: DOMRect; reason: RenameRejection; value: string } | null>(null);
  const todoPill = useTodoPillContent(activity.todo);
  const showTodoPill = todoPill.visible && (tier === 'full' || tier === 'compact');
  const runningArgv0 = paneState.currentCommand?.rawCommandLine
    ? commandArgv0(paneState.currentCommand.rawCommandLine)
    : null;
  const alertButtonLabels = alertButtonLabelsFor(activity.status, runningArgv0);
  const alertButtonAriaLabel = alertButtonLabels.aria;
  const alertButtonTooltip = alertButtonLabels.tooltip;
  const alertButtonTooltipDetail = activity.status === 'ALERT_RINGING'
    ? 'Click to dismiss and show options'
    : 'Right-click for options';
  const todoNotificationPreview = formatNotificationPreview(activity.notification);
  const todoPreviewId = `todo-notification-preview-${id}`;

  const closeTodoPreview = useCallback(() => setTodoPreviewRect(null), []);
  const closeRenameWarning = useCallback(() => setRenameWarning(null), []);
  const submitRename = useCallback((value: string, anchor: HTMLElement) => {
    const rect = anchor.getBoundingClientRect();
    const result = actions.onFinishRename(id, value);
    if (!result.accepted) {
      setRenameWarning({ rect, reason: result.reason, value });
    } else {
      setRenameWarning(null);
    }
  }, [actions, id]);
  const openTodoPreview = useCallback((button: HTMLButtonElement) => {
    if (!activity.notification) return;
    setTodoPreviewRect(button.getBoundingClientRect());
  }, [activity.notification]);

  const triggerAlertButtonAction = useCallback((displayedStatus: SessionStatus, button: HTMLButtonElement) => {
    const result = actions.onAlertButton(id, displayedStatus);
    // 'no-command' opens the dialog too — it is where we explain that alerts are
    // keyed on the running command and there is nothing running here.
    if (result === 'dismissed' || result === 'menu' || result === 'no-command') {
      const rect = button.getBoundingClientRect();
      context.open(id, { origin: { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } });
    }
  }, [actions, id, context]);

  useEffect(() => {
    if (!activity.notification) setTodoPreviewRect(null);
  }, [activity.notification]);

  return (
    <div
      ref={tabRef}
      data-pane-header-for={id}
      className={tabVariant({ state: isActiveHeader ? 'active' : 'inactive' })}
      onMouseDown={() => actions.onClickPanel(id)}
      onContextMenu={(e) => {
        // Header and alert entry points share the terminal context.
        e.preventDefault();
        e.stopPropagation();
        context.open(id, { origin: { x: e.clientX, y: e.clientY } });
      }}
    >
      <ToolDirtyIndicator dirty={dirty} />
      <div className="flex flex-1 min-w-0 items-center gap-1.5 overflow-hidden">
        {isRenaming ? (
          <InlineEditInput
            data-renaming-input-for={id}
            className="bg-transparent outline-none border-none text-inherit font-medium font-mono w-full min-w-0 p-0 m-0"
            initialValue={displayTitleBase}
            blurAction="submit"
            onSubmit={submitRename}
            onCancel={actions.onCancelRename}
          />
        ) : (
          <span
            data-pane-title-for={id}
            className="inline-flex max-w-full min-w-0 shrink cursor-text items-baseline overflow-hidden font-medium text-inherit decoration-current/50 underline-offset-2 hover:underline"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); actions.onStartRename(id); }}
          >
            <span className="min-w-0 shrink truncate">{displayTitleBase}</span>
            {showsFailGlyph && (
              <span className="ml-1 shrink-0 text-error" aria-label="last command failed">{COMMAND_FAIL_GLYPH}</span>
            )}
            {derivedHeader.secondary && (
              <span className="ml-1 min-w-0 shrink truncate opacity-70">{derivedHeader.secondary}</span>
            )}
          </span>
        )}
        <HeaderActionButton
          className={[
            'flex h-5 min-w-5 items-center justify-center rounded transition-colors shrink-0 hover:bg-current/10',
            activity.status === 'ALERT_RINGING'
              ? (isActiveHeader ? 'text-alarm-vs-header-active' : 'text-alarm-vs-header-inactive')
              : '',
          ].join(' ')}
          onMouseDownCapture={(e) => {
            if (e.button !== 0) return;
            suppressAlertClickRef.current = true;
            e.preventDefault();
            e.stopPropagation();
            e.nativeEvent.stopImmediatePropagation?.();
            triggerAlertButtonAction(activity.status, e.currentTarget);
          }}
          onClick={(e) => {
            if (suppressAlertClickRef.current) {
              suppressAlertClickRef.current = false;
              return;
            }
            triggerAlertButtonAction(activity.status, e.currentTarget);
          }}
          onContextMenu={(e) => context.open(id, { origin: { x: e.clientX, y: e.clientY } })}
          ariaLabel={alertButtonAriaLabel}
          tooltip={alertButtonTooltip}
          tooltipDetail={alertButtonTooltipDetail}
          tooltipAlign="left"
          dataAlertButtonFor={id}
        >
          <span className="flex items-center justify-center">
            <AlertBell status={activity.status} ringSeq={activity.ringSeq} size={14} />
          </span>
        </HeaderActionButton>
        {showTodoPill && (
          <button
            type="button"
            data-session-todo-for={id}
            data-flourishing={todoPill.flourishing ? 'true' : 'false'}
            className={`todo-pill-shell shrink-0 rounded border border-current px-1.5 py-px text-xs font-semibold ${TODO_PILL_TRACKING_CLASS} transition-colors hover:bg-current/10 focus:outline-none`}
            aria-label={todoNotificationPreview ? `Dismiss TODO: ${todoNotificationPreview}` : 'Dismiss TODO'}
            aria-describedby={todoPreviewRect && activity.notification ? todoPreviewId : undefined}
            aria-hidden={todoPill.flourishing ? true : undefined}
            onMouseDown={(e) => e.stopPropagation()}
            onMouseEnter={(e) => openTodoPreview(e.currentTarget)}
            onMouseLeave={closeTodoPreview}
            onFocus={(e) => openTodoPreview(e.currentTarget)}
            onBlur={closeTodoPreview}
            onClick={(e) => {
              e.stopPropagation();
              closeTodoPreview();
              clearSessionTodo(id);
            }}
          >
            {todoPill.body}
          </button>
        )}
      </div>
      {!isRenaming && (
        <>
          {showMouseIcon && (tier === 'full' || tier === 'compact') && (
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
          {tier !== 'tiny' && <NotepadHeaderButton surfaceId={id} hideWhenEmpty={tier === 'minimal'} />}
          {tier === 'full' && (
            <div className="ml-1 flex shrink-0 items-center gap-0.5">
              <HeaderActionButton
                className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
                onClick={(e) => { e.stopPropagation(); actions.onSplitH(id); }}
                ariaLabel="Split left/right"
                tooltip="Split left/right [|] or [%]"
              ><SplitHorizontalIcon size={14} /></HeaderActionButton>
              <HeaderActionButton
                className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
                onClick={(e) => { e.stopPropagation(); actions.onSplitV(id); }}
                ariaLabel="Split top/bottom"
                tooltip={'Split top/bottom [-] or ["]'}
              ><SplitVerticalIcon size={14} /></HeaderActionButton>
            </div>
          )}
          {/*
            Zoom + minimize + close are the highest-priority controls: they sit
            last (so nothing fixed-width is to their right to push them off) and
            every other element yields first — the title/bell region clips via
            `overflow-hidden`, the splits drop below the `full` tier, and the
            TODO pill, mouse icon, and notepad drop at `minimal`/`tiny`. At
            `tiny` even minimize and kill go: zoom is the last control standing,
            because zooming is how you get back everything the header dropped.
          */}
          <div className="ml-1 flex shrink-0 items-center gap-0.5">
            <HeaderActionButton
              className={paneZoomButtonClass(zoomed, isActiveHeader)}
              onClick={(e) => { e.stopPropagation(); actions.onZoom(id); }}
              ariaLabel={zoomed ? 'Unzoom' : 'Zoom'}
              tooltip={zoomed ? 'Unzoom' : 'Zoom [z]'}
            >{zoomed ? <ArrowsInIcon size={14} /> : <ArrowsOutIcon size={14} />}</HeaderActionButton>
            {tier !== 'tiny' && (
              <>
                <HeaderActionButton
                  className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
                  onClick={(e) => { e.stopPropagation(); actions.onMinimize(id); }}
                  ariaLabel="Minimize"
                  tooltip="Minimize [m] or [d]"
                ><ArrowLineDownIcon size={14} /></HeaderActionButton>
                <HeaderActionButton
                  className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
                  onClick={(e) => { e.stopPropagation(); actions.onKill(id); }}
                  ariaLabel="Kill"
                  tooltip="Kill [k] or [x]"
                ><XIcon size={14} /></HeaderActionButton>
              </>
            )}
          </div>
        </>
      )}
      {todoPreviewRect && activity.notification && context.id !== id && (
        <TodoNotificationPreview
          id={todoPreviewId}
          notification={activity.notification}
          anchorRect={todoPreviewRect}
        />
      )}
      {renameWarning && (
        <IllegalRenameWarning
          anchorRect={renameWarning.rect}
          reason={renameWarning.reason}
          attemptedValue={renameWarning.value}
          onClose={closeRenameWarning}
        />
      )}
    </div>
  );
}

function TodoNotificationPreview({
  id,
  notification,
  anchorRect,
}: {
  id: string;
  notification: { title: string | null; body: string | null };
  anchorRect: DOMRect;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.bottom + TODO_PREVIEW_GAP,
  });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = anchorRect.bottom + TODO_PREVIEW_GAP;
    const maxLeft = Math.max(TODO_PREVIEW_MARGIN, window.innerWidth - rect.width - TODO_PREVIEW_MARGIN);
    setStyle({
      position: 'fixed',
      left: Math.min(Math.max(anchorRect.left, TODO_PREVIEW_MARGIN), maxLeft),
      top,
      maxHeight: Math.max(48, window.innerHeight - top - TODO_PREVIEW_MARGIN),
    });
  }, [anchorRect]);

  return createPortal(
    <div
      ref={ref}
      id={id}
      role="tooltip"
      className={`${POPUP_SURFACE_CLASS} max-w-80 px-2.5 py-2 text-sm leading-snug`}
      style={style}
    >
      {notification.title && (
        <div className="font-medium break-words">{notification.title}</div>
      )}
      {notification.body && (
        <div
          className="mt-1 whitespace-pre-wrap break-words text-muted"
          style={{
            display: '-webkit-box',
            WebkitBoxOrient: 'vertical',
            WebkitLineClamp: 3,
            overflow: 'hidden',
          }}
        >
          {notification.body}
        </div>
      )}
    </div>,
    document.body,
  );
}

function formatNotificationPreview(notification: { title: string | null; body: string | null } | null): string | undefined {
  if (!notification) return undefined;
  const parts = [notification.title, notification.body].filter((part): part is string => !!part);
  if (parts.length === 0) return undefined;
  const preview = parts.join('\n');
  return preview.length > 512 ? `${preview.slice(0, 509)}...` : preview;
}

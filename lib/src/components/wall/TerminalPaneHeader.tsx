import { useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { tv } from 'tailwind-variants';
import {
  ArrowLineDownIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  BellIcon,
  CursorClickIcon,
  CursorTextIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  XIcon,
} from '@phosphor-icons/react';
import { HeaderActionButton } from '../HeaderActionButton';
import { TodoAlertDialog } from '../TodoAlertDialog';
import { POPUP_SURFACE_CLASS, TERMINAL_TOP_RADIUS_CLASS, TODO_PILL_TRACKING_CLASS } from '../design';
import { bellIconClass } from '../bell-icon-class';
import { useTodoPillContent } from '../TodoPillBody';
import type { PaneProps } from './pane-props';
import { IllegalRenameWarning, type RenameRejection } from './IllegalRenameWarning';
import { PaneHeaderContextMenu } from './PaneHeaderContextMenu';
import { useDismissOverlay } from './use-dismiss-overlay';
import {
  DEFAULT_MOUSE_SELECTION_STATE,
  getMouseSelectionSnapshot,
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
  createTerminalPaneState,
  COMMAND_FAIL_GLYPH,
  deriveHeader,
  resolveDisplayPrimary,
  titleCandidatesForDisplay,
  titleSourceLabel,
  type TerminalTitle,
} from '../../lib/terminal-state';
import {
  DialogKeyboardContext,
  ModeContext,
  WallActionsContext,
  RenamingIdContext,
  SelectedIdContext,
  WindowFocusedContext,
  ZoomedContext,
} from './wall-context';

const tabVariant = tv({
  base: `flex h-full w-full cursor-grab items-center gap-1.5 ${TERMINAL_TOP_RADIUS_CLASS} pl-2 pr-[5px] text-sm leading-none font-mono select-none active:cursor-grabbing`,
  variants: {
    state: {
      active: 'bg-header-active-bg text-header-active-fg',
      inactive: 'bg-header-inactive-bg text-header-inactive-fg',
    },
  },
});

type HeaderTier = 'full' | 'compact' | 'minimal';

const ALERT_BUTTON_ENABLED = { aria: 'Disable watching', tooltip: '[a] Disable WATCHING' };
const ALERT_BUTTON_LABELS: Record<SessionStatus, { aria: string; tooltip: string }> = {
  WATCHING_DISABLED: { aria: 'Enable watching', tooltip: '[a] Enable WATCHING' },
  NOTHING_TO_SHOW: ALERT_BUTTON_ENABLED,
  MIGHT_BE_BUSY: ALERT_BUTTON_ENABLED,
  BUSY: ALERT_BUTTON_ENABLED,
  MIGHT_NEED_ATTENTION: ALERT_BUTTON_ENABLED,
  ALERT_RINGING: { aria: 'Alert ringing', tooltip: 'Alert ringing' },
  OSC_NOTIF_BUSY: { aria: 'Progress active', tooltip: 'Progress active' },
  COMMAND_EXIT_ARMED: { aria: 'Command running', tooltip: 'Command running' },
};
const TODO_PREVIEW_GAP = 6;
const TODO_PREVIEW_MARGIN = 8;
const TITLE_CANDIDATES_GAP = 6;
const TITLE_CANDIDATES_MARGIN = 8;

export function TerminalPaneHeader({ id, title }: PaneProps) {
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const renamingId = useContext(RenamingIdContext);
  const zoomed = useContext(ZoomedContext);
  const windowFocused = useContext(WindowFocusedContext);
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);
  const activityStates = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const terminalStates = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot);
  const mouseStates = useSyncExternalStore(subscribeToMouseSelection, getMouseSelectionSnapshot);
  const actions = useContext(WallActionsContext);
  const activity = activityStates.get(id) ?? DEFAULT_ACTIVITY_STATE;
  const paneState = terminalStates.get(id) ?? createTerminalPaneState();
  const allPaneStates = useMemo(() => [...terminalStates.values()], [terminalStates]);
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
  const mouseState = mouseStates.get(id) ?? DEFAULT_MOUSE_SELECTION_STATE;
  const showMouseIcon = mouseState.mouseReporting !== 'none';
  const inOverride = mouseState.override !== 'off';
  const mouseIconTooltip: string | null = mouseState.override === 'permanent'
    ? "You're overriding the TUI's mouse capture. Click to restore."
    : mouseState.override === 'temporary'
      ? null
      : 'TUI is intercepting mouse commands. Click to override.';
  const mouseIconAriaLabel = inOverride ? 'Restore mouse capture' : 'Override mouse capture';
  const isSelected = selectedId === id;
  const isActiveHeader = mode === 'passthrough' && isSelected && windowFocused;
  const isRenaming = renamingId === id;
  const tabRef = useRef<HTMLDivElement>(null);
  const titleSpanRef = useRef<HTMLSpanElement>(null);
  const suppressAlertClickRef = useRef(false);
  const [tier, setTier] = useState<HeaderTier>('full');
  const [dialogTriggerRect, setDialogTriggerRect] = useState<DOMRect | null>(null);
  const [todoPreviewRect, setTodoPreviewRect] = useState<DOMRect | null>(null);
  const [titleCandidatesRect, setTitleCandidatesRect] = useState<DOMRect | null>(null);
  const [contextMenu, setContextMenu] = useState<{ x: number; y: number } | null>(null);
  const [renameWarning, setRenameWarning] = useState<{ rect: DOMRect; reason: RenameRejection; value: string } | null>(null);
  const todoPill = useTodoPillContent(activity.todo);
  const titleCandidates = useMemo(() => titleCandidatesForDisplay(paneState), [paneState]);
  const showTodoPill = todoPill.visible && tier !== 'minimal';
  const alertButtonLabels = ALERT_BUTTON_LABELS[activity.status];
  const alertButtonAriaLabel = alertButtonLabels.aria;
  const alertButtonTooltip = alertButtonLabels.tooltip;
  const alertButtonTooltipDetail = activity.status === 'ALERT_RINGING'
    ? 'Click to dismiss and show options'
    : 'Right-click for options';
  const todoNotificationPreview = formatNotificationPreview(activity.notification);
  const todoPreviewId = `todo-notification-preview-${id}`;

  const closeDialog = useCallback(() => setDialogTriggerRect(null), []);
  const closeTodoPreview = useCallback(() => setTodoPreviewRect(null), []);
  const closeTitleCandidates = useCallback(() => setTitleCandidatesRect(null), []);
  const closeContextMenu = useCallback(() => setContextMenu(null), []);
  // Reachable from the context menu now that the title span owns no right-click.
  // Anchor to the span; fall back to the menu's pointer position when the span is
  // absent (e.g. mid-rename, when an input replaces it).
  const showTitleCandidates = useCallback(() => {
    const rect = titleSpanRef.current?.getBoundingClientRect()
      ?? (contextMenu ? new DOMRect(contextMenu.x, contextMenu.y, 0, 0) : null);
    if (rect) setTitleCandidatesRect(rect);
  }, [contextMenu]);
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
    if (result === 'dismissed' || result === 'menu') {
      setDialogTriggerRect(button.getBoundingClientRect());
    }
  }, [actions, id]);

  useEffect(() => {
    const el = tabRef.current;
    if (!el) return;
    const ro = new ResizeObserver(([entry]) => {
      const w = entry.contentRect.width;
      if (w > 280) setTier('full');
      else if (w > 160) setTier('compact');
      else setTier('minimal');
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!activity.notification) setTodoPreviewRect(null);
  }, [activity.notification]);

  return (
    <div
      ref={tabRef}
      className={tabVariant({ state: isActiveHeader ? 'active' : 'inactive' })}
      onMouseDown={() => actions.onClickPanel(id)}
      onContextMenu={(e) => {
        // The whole header opens this one menu; only the bell button
        // stopPropagations its own right-click (the alert dialog). Right-clicks
        // on the title now bubble here — the menu offers "title candidates".
        e.preventDefault();
        e.stopPropagation();
        setContextMenu({ x: e.clientX, y: e.clientY });
      }}
    >
      <div className="flex flex-1 min-w-0 items-center gap-1.5 overflow-hidden">
        {isRenaming ? (
          <input
            data-renaming-input-for={id}
            className="bg-transparent outline-none border-none text-inherit font-medium font-mono w-full min-w-0 p-0 m-0"
            defaultValue={displayTitleBase}
            autoFocus
            ref={(el) => el?.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                submitRename((e.target as HTMLInputElement).value, e.currentTarget);
              }
              if (e.key === 'Escape') actions.onCancelRename();
              e.stopPropagation();
            }}
            onBlur={(e) => submitRename(e.target.value, e.currentTarget)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            ref={titleSpanRef}
            data-title-candidates-for={id}
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
          onContextMenu={(e) => {
            e.preventDefault();
            setDialogTriggerRect(e.currentTarget.getBoundingClientRect());
          }}
          ariaLabel={alertButtonAriaLabel}
          tooltip={alertButtonTooltip}
          tooltipDetail={alertButtonTooltipDetail}
          tooltipAlign="left"
          dataAlertButtonFor={id}
        >
          <span className="flex items-center justify-center">
            {activity.status === 'WATCHING_DISABLED' ? (
              <BellIcon size={14} />
            ) : (
              <BellIcon size={14} weight="fill" className={bellIconClass(activity.status)} />
            )}
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
          {showMouseIcon && tier !== 'minimal' && (
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
              <HeaderActionButton
                className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
                onClick={(e) => { e.stopPropagation(); actions.onZoom(id); }}
                ariaLabel={zoomed ? 'Unzoom' : 'Zoom'}
                tooltip={zoomed ? 'Unzoom [z]' : 'Zoom [z]'}
              >{zoomed ? <ArrowsInIcon size={14} /> : <ArrowsOutIcon size={14} />}</HeaderActionButton>
            </div>
          )}
          {/*
            Minimize + close are the highest-priority controls: they must stay
            visible no matter how narrow the header gets. They sit last (so
            nothing fixed-width is to their right to push them off) and every
            other element yields first — the title/bell region clips via
            `overflow-hidden`, split/zoom drop below the `full` tier, and the
            mouse icon drops at the `minimal` tier.
          */}
          <div className="ml-1 flex shrink-0 items-center gap-0.5">
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
          </div>
        </>
      )}
      {dialogTriggerRect && (
        <TodoAlertDialog
          triggerRect={dialogTriggerRect}
          sessionId={id}
          onClose={closeDialog}
          onKeyboardActiveChange={setDialogKeyboardActive}
        />
      )}
      {todoPreviewRect && activity.notification && !dialogTriggerRect && (
        <TodoNotificationPreview
          id={todoPreviewId}
          notification={activity.notification}
          anchorRect={todoPreviewRect}
        />
      )}
      {titleCandidatesRect && !dialogTriggerRect && (
        <TitleCandidatesPopover
          anchorRect={titleCandidatesRect}
          candidates={titleCandidates}
          currentTitle={displayTitleBase}
          onClose={closeTitleCandidates}
        />
      )}
      {contextMenu && (
        <PaneHeaderContextMenu
          id={id}
          anchor={contextMenu}
          onClose={closeContextMenu}
          onShowTitleCandidates={showTitleCandidates}
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

function TitleCandidatesPopover({
  anchorRect,
  candidates,
  currentTitle,
  onClose,
}: {
  anchorRect: DOMRect;
  candidates: TerminalTitle[];
  currentTitle: string;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [style, setStyle] = useState<CSSProperties>({
    position: 'fixed',
    left: anchorRect.left,
    top: anchorRect.bottom + TITLE_CANDIDATES_GAP,
  });

  useDismissOverlay(onClose);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const rect = el.getBoundingClientRect();
    const top = anchorRect.bottom + TITLE_CANDIDATES_GAP;
    const maxLeft = Math.max(TITLE_CANDIDATES_MARGIN, window.innerWidth - rect.width - TITLE_CANDIDATES_MARGIN);
    setStyle({
      position: 'fixed',
      left: Math.min(Math.max(anchorRect.left, TITLE_CANDIDATES_MARGIN), maxLeft),
      top,
      maxHeight: Math.max(80, window.innerHeight - top - TITLE_CANDIDATES_MARGIN),
    });
  }, [anchorRect]);

  return createPortal(
    <div
      ref={ref}
      role="dialog"
      aria-label="Title candidates"
      className={`${POPUP_SURFACE_CLASS} max-w-96 overflow-auto px-2.5 py-2 text-sm leading-snug`}
      style={style}
      onPointerDown={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      onContextMenu={(e) => e.preventDefault()}
    >
      <div className="mb-2 flex items-center justify-between gap-3 border-b border-border pb-1.5">
        <div className="min-w-0 truncate font-medium">{currentTitle}</div>
        <button
          type="button"
          className="shrink-0 rounded px-1 text-muted transition-colors hover:bg-current/10 hover:text-foreground"
          aria-label="Close title candidates"
          onClick={onClose}
        >
          <XIcon size={12} />
        </button>
      </div>
      {candidates.length === 0 ? (
        <div className="text-muted">No title candidates</div>
      ) : (
        <div className="space-y-1.5">
          {candidates.map((candidate) => (
            <div key={candidate.source} className="grid grid-cols-[4.75rem_minmax(0,1fr)_auto] items-baseline gap-2">
              <span className="text-muted">{titleSourceLabel(candidate.source)}</span>
              <span className="min-w-0 truncate" title={candidate.title}>{candidate.title}</span>
              <time className="text-xs text-muted" dateTime={formatTitleCandidateDateTime(candidate.updatedAt)}>
                {formatTitleCandidateTime(candidate.updatedAt)}
              </time>
            </div>
          ))}
        </div>
      )}
    </div>,
    document.body,
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

function formatTitleCandidateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp)) return 'unknown';
  return new Date(timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatTitleCandidateDateTime(timestamp: number): string | undefined {
  if (!Number.isFinite(timestamp)) return undefined;
  return new Date(timestamp).toISOString();
}

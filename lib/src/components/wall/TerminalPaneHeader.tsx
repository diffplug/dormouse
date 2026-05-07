import { useCallback, useContext, useEffect, useRef, useState, useSyncExternalStore } from 'react';
import type { IDockviewPanelHeaderProps } from 'dockview-react';
import { tv } from 'tailwind-variants';
import {
  ArrowLineDownIcon,
  ArrowsInIcon,
  ArrowsOutIcon,
  BellIcon,
  BellSlashIcon,
  CursorClickIcon,
  SelectionSlashIcon,
  SplitHorizontalIcon,
  SplitVerticalIcon,
  XIcon,
} from '@phosphor-icons/react';
import { HeaderActionButton } from '../HeaderActionButton';
import { TodoAlertDialog } from '../TodoAlertDialog';
import { TERMINAL_TOP_RADIUS_CLASS, TODO_PILL_TRACKING_CLASS } from '../design';
import { bellIconClass } from '../bell-icon-class';
import { useTodoPillContent } from '../TodoPillBody';
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
  subscribeToActivity,
  type SessionStatus,
} from '../../lib/terminal-registry';
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

const ALERT_BUTTON_ENABLED = { aria: 'Disable alert', tooltip: '[a] Disable alerts' };
const ALERT_BUTTON_LABELS: Record<SessionStatus, { aria: string; tooltip: string }> = {
  ALERT_DISABLED: { aria: 'Enable alert', tooltip: '[a] Enable alerts' },
  NOTHING_TO_SHOW: ALERT_BUTTON_ENABLED,
  MIGHT_BE_BUSY: ALERT_BUTTON_ENABLED,
  BUSY: ALERT_BUTTON_ENABLED,
  MIGHT_NEED_ATTENTION: ALERT_BUTTON_ENABLED,
  ALERT_RINGING: { aria: 'Alert ringing', tooltip: 'Alert ringing' },
  OSC_NOTIF_BUSY: { aria: 'Progress active', tooltip: 'Progress active' },
};

export function TerminalPaneHeader({ api }: IDockviewPanelHeaderProps) {
  const mode = useContext(ModeContext);
  const selectedId = useContext(SelectedIdContext);
  const renamingId = useContext(RenamingIdContext);
  const zoomed = useContext(ZoomedContext);
  const windowFocused = useContext(WindowFocusedContext);
  const setDialogKeyboardActive = useContext(DialogKeyboardContext);
  const activityStates = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const mouseStates = useSyncExternalStore(subscribeToMouseSelection, getMouseSelectionSnapshot);
  const actions = useContext(WallActionsContext);
  const activity = activityStates.get(api.id) ?? DEFAULT_ACTIVITY_STATE;
  const mouseState = mouseStates.get(api.id) ?? DEFAULT_MOUSE_SELECTION_STATE;
  const showMouseIcon = mouseState.mouseReporting !== 'none';
  const inOverride = mouseState.override !== 'off';
  const mouseIconTooltip: string | null = mouseState.override === 'permanent'
    ? "You're overriding the TUI's mouse capture. Click to restore."
    : mouseState.override === 'temporary'
      ? null
      : 'TUI is intercepting mouse commands. Click to override.';
  const mouseIconAriaLabel = inOverride ? 'Restore mouse capture' : 'Override mouse capture';
  const isSelected = selectedId === api.id;
  const isActiveHeader = mode === 'passthrough' && isSelected && windowFocused;
  const isRenaming = renamingId === api.id;
  const tabRef = useRef<HTMLDivElement>(null);
  const suppressAlertClickRef = useRef(false);
  const [tier, setTier] = useState<HeaderTier>('full');
  const [dialogTriggerRect, setDialogTriggerRect] = useState<DOMRect | null>(null);
  const todoPill = useTodoPillContent(activity.todo);
  const showTodoPill = todoPill.visible && tier !== 'minimal';
  const alertButtonLabels = ALERT_BUTTON_LABELS[activity.status];
  const alertButtonAriaLabel = alertButtonLabels.aria;
  const alertButtonTooltip = alertButtonLabels.tooltip;
  const alertButtonTooltipDetail = activity.status === 'ALERT_RINGING'
    ? 'Click to dismiss and show options'
    : 'Right-click for options';
  const todoNotificationPreview = formatNotificationPreview(activity.notification);

  const closeDialog = useCallback(() => setDialogTriggerRect(null), []);

  const triggerAlertButtonAction = useCallback((displayedStatus: SessionStatus, button: HTMLButtonElement) => {
    const result = actions.onAlertButton(api.id, displayedStatus);
    if (result === 'dismissed') {
      setDialogTriggerRect(button.getBoundingClientRect());
    }
  }, [actions, api.id]);

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

  return (
    <div
      ref={tabRef}
      className={tabVariant({ state: isActiveHeader ? 'active' : 'inactive' })}
      onMouseDown={() => actions.onClickPanel(api.id)}
    >
      <div className="flex flex-1 min-w-0 items-center gap-2">
        {isRenaming ? (
          <input
            className="bg-transparent outline-none border-none text-inherit font-medium font-mono w-full min-w-0 p-0 m-0"
            defaultValue={api.title}
            autoFocus
            ref={(el) => el?.select()}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                actions.onFinishRename(api.id, (e.target as HTMLInputElement).value);
              }
              if (e.key === 'Escape') actions.onCancelRename();
              e.stopPropagation();
            }}
            onBlur={(e) => actions.onFinishRename(api.id, e.target.value)}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => e.stopPropagation()}
          />
        ) : (
          <span
            className="min-w-0 truncate cursor-text font-medium text-inherit decoration-current/50 underline-offset-2 hover:underline"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); actions.onStartRename(api.id); }}
          >{api.title}</span>
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
          dataAlertButtonFor={api.id}
        >
          <span className="flex items-center justify-center">
            {activity.status === 'ALERT_DISABLED' ? (
              <BellSlashIcon size={14} />
            ) : (
              <BellIcon size={14} weight="fill" className={bellIconClass(activity.status)} />
            )}
          </span>
        </HeaderActionButton>
        {showTodoPill && (
          <button
            type="button"
            data-session-todo-for={api.id}
            data-flourishing={todoPill.flourishing ? 'true' : 'false'}
            className={`todo-pill-shell shrink-0 rounded border border-current px-1.5 py-px text-xs font-semibold ${TODO_PILL_TRACKING_CLASS} transition-colors hover:bg-current/10`}
            aria-label={todoNotificationPreview ? `Dismiss TODO: ${todoNotificationPreview}` : 'Dismiss TODO'}
            aria-hidden={todoPill.flourishing ? true : undefined}
            title={todoNotificationPreview}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={(e) => {
              e.stopPropagation();
              clearSessionTodo(api.id);
            }}
          >
            {todoPill.body}
          </button>
        )}
      </div>
      {!isRenaming && (
        <>
          {showMouseIcon && (
            <div className="ml-1 shrink-0">
              <HeaderActionButton
                className="flex h-5 min-w-5 items-center justify-center rounded transition-colors shrink-0 hover:bg-current/10"
                onMouseDown={(e) => e.stopPropagation()}
                onClick={(e) => {
                  e.stopPropagation();
                  setMouseOverride(api.id, inOverride ? 'off' : 'temporary');
                }}
                ariaLabel={mouseIconAriaLabel}
                tooltip={mouseIconTooltip}
              >
                <span className="relative flex items-center justify-center">
                  {inOverride ? (
                    <SelectionSlashIcon size={14} />
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
          )}
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
        </>
      )}
      {dialogTriggerRect && (
        <TodoAlertDialog
          triggerRect={dialogTriggerRect}
          sessionId={api.id}
          onClose={closeDialog}
          onKeyboardActiveChange={setDialogKeyboardActive}
        />
      )}
    </div>
  );
}

function formatNotificationPreview(notification: { title: string | null; body: string | null } | null): string | undefined {
  if (!notification) return undefined;
  const parts = [notification.title, notification.body].filter((part): part is string => !!part);
  if (parts.length === 0) return undefined;
  const preview = parts.join('\n');
  return preview.length > 512 ? `${preview.slice(0, 509)}...` : preview;
}

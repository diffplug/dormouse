import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  ArrowLineDownIcon,
  BellIcon,
  XIcon,
} from '@phosphor-icons/react';
import { HeaderActionButton } from './HeaderActionButton';
import { TerminalPane } from './TerminalPane';
import { bellIconClass } from './bell-icon-class';
import { TODO_PILL_TRACKING_CLASS } from './design';
import { useTodoPillContent } from './TodoPillBody';
import type { MobileTerminalSessionItem } from './MobileTerminalUi';
import {
  clearSessionTodo,
  DEFAULT_ACTIVITY_STATE,
  dismissOrToggleAlert,
  disposeSession,
  getActivitySnapshot,
  getOrCreateTerminal,
  getTerminalPaneStateSnapshot,
  setTerminalUserTitle,
  subscribeToActivity,
  subscribeToTerminalPaneState,
  type SessionStatus,
} from '../lib/terminal-registry';
import {
  buildAppTitleResolver,
  createTerminalPaneState,
  DEFAULT_IDLE_TITLE,
  deriveHeader,
  resolveDisplayPrimary,
} from '../lib/terminal-state';

export interface MobileWallSession {
  id: string;
  title?: string;
}

export interface MobileWallProps {
  sessions?: MobileWallSession[];
  activeSessionId?: string;
  defaultActiveSessionId?: string;
  onActiveSessionChange?: (id: string) => void;
  onSessionMinimize?: (id: string) => void;
  onSessionKill?: (id: string) => void;
  className?: string;
}

const DEFAULT_MOBILE_SESSION: MobileWallSession = { id: 'mobile-pane' };

const ALERT_BUTTON_LABELS: Record<SessionStatus, { aria: string; tooltip: string }> = {
  WATCHING_DISABLED: { aria: 'Enable watching', tooltip: 'Enable watching' },
  NOTHING_TO_SHOW: { aria: 'Disable watching', tooltip: 'Disable watching' },
  MIGHT_BE_BUSY: { aria: 'Disable watching', tooltip: 'Disable watching' },
  BUSY: { aria: 'Disable watching', tooltip: 'Disable watching' },
  MIGHT_NEED_ATTENTION: { aria: 'Disable watching', tooltip: 'Disable watching' },
  ALERT_RINGING: { aria: 'Alert ringing', tooltip: 'Alert ringing' },
  OSC_NOTIF_BUSY: { aria: 'Progress active', tooltip: 'Progress active' },
  COMMAND_EXIT_ARMED: { aria: 'Command running', tooltip: 'Command running' },
};

export function useMobileWallSessionItems(
  sessions: MobileWallSession[],
  activeSessionId: string | null,
): MobileTerminalSessionItem[] {
  const activityStates = useSyncExternalStore(subscribeToActivity, getActivitySnapshot, getActivitySnapshot);
  const terminalStates = useSyncExternalStore(subscribeToTerminalPaneState, getTerminalPaneStateSnapshot, getTerminalPaneStateSnapshot);
  const allSessionStates = useMemo(
    () => sessions.map((session) => terminalStates.get(session.id) ?? createTerminalPaneState()),
    [sessions, terminalStates],
  );
  const visiblePaneStates = allSessionStates.length > 0 ? allSessionStates : [createTerminalPaneState()];
  const appTitleForPane = useMemo(
    () => buildAppTitleResolver(terminalStates, activityStates),
    [terminalStates, activityStates],
  );

  return useMemo(() => sessions.map((session) => {
    const paneState = terminalStates.get(session.id) ?? createTerminalPaneState();
    const activity = activityStates.get(session.id) ?? DEFAULT_ACTIVITY_STATE;
    const derivedHeader = deriveHeader(paneState, visiblePaneStates, { appTitleForPane });
    const primary = resolveDisplayPrimary(derivedHeader.primary, session.title);
    return {
      id: session.id,
      title: primary === DEFAULT_IDLE_TITLE && session.title ? session.title : primary,
      secondary: derivedHeader.secondary,
      active: session.id === activeSessionId,
      status: activity.status,
      todo: activity.todo,
    };
  }), [activeSessionId, activityStates, appTitleForPane, sessions, terminalStates, visiblePaneStates]);
}

export function MobileWall({
  sessions: controlledSessions,
  activeSessionId,
  defaultActiveSessionId,
  onActiveSessionChange,
  onSessionMinimize,
  onSessionKill,
  className,
}: MobileWallProps) {
  const [internalSessions, setInternalSessions] = useState<MobileWallSession[]>(() => controlledSessions ?? [DEFAULT_MOBILE_SESSION]);
  const sessions = controlledSessions ?? internalSessions;
  const firstSessionId = sessions[0]?.id ?? null;
  const [internalActiveSessionId, setInternalActiveSessionId] = useState<string | null>(defaultActiveSessionId ?? firstSessionId);
  const resolvedActiveSessionId = activeSessionId ?? internalActiveSessionId ?? firstSessionId;
  const sessionItems = useMobileWallSessionItems(sessions, resolvedActiveSessionId);
  const activeItem = sessionItems.find((session) => session.id === resolvedActiveSessionId) ?? sessionItems[0] ?? null;

  const selectSession = useCallback((id: string) => {
    if (activeSessionId === undefined) setInternalActiveSessionId(id);
    onActiveSessionChange?.(id);
  }, [activeSessionId, onActiveSessionChange]);

  const killSession = useCallback((id: string) => {
    disposeSession(id);
    onSessionKill?.(id);
    if (controlledSessions) {
      const fallback = sessions.find((session) => session.id !== id)?.id ?? null;
      if (fallback && id === resolvedActiveSessionId) selectSession(fallback);
      return;
    }

    setInternalSessions((current) => {
      const next = current.filter((session) => session.id !== id);
      const fallback = next[0]?.id ?? null;
      if (id === resolvedActiveSessionId) setInternalActiveSessionId(fallback);
      return next;
    });
  }, [controlledSessions, onSessionKill, resolvedActiveSessionId, selectSession, sessions]);

  useEffect(() => {
    for (const session of sessions) {
      getOrCreateTerminal(session.id);
      if (session.title) setTerminalUserTitle(session.id, session.title);
    }
  }, [sessions]);

  useEffect(() => {
    if (!resolvedActiveSessionId && firstSessionId) {
      selectSession(firstSessionId);
      return;
    }
    if (resolvedActiveSessionId && !sessions.some((session) => session.id === resolvedActiveSessionId) && firstSessionId) {
      selectSession(firstSessionId);
    }
  }, [firstSessionId, resolvedActiveSessionId, selectSession, sessions]);

  if (!activeItem) {
    return (
      <div className={`grid h-full place-items-center bg-app-bg font-mono text-sm text-muted ${className ?? ''}`}>
        No sessions
      </div>
    );
  }

  return (
    <div className={`flex h-full min-h-0 flex-col overflow-hidden bg-app-bg ${className ?? ''}`}>
      <MobileWallHeader
        session={activeItem}
        onMinimize={() => onSessionMinimize?.(activeItem.id)}
        onKill={() => killSession(activeItem.id)}
      />
      <div className="min-h-0 flex-1 overflow-hidden bg-terminal-bg">
        <TerminalPane id={activeItem.id} isFocused />
      </div>
    </div>
  );
}

function MobileWallHeader({
  session,
  onMinimize,
  onKill,
}: {
  session: MobileTerminalSessionItem;
  onMinimize: () => void;
  onKill: () => void;
}) {
  const status = session.status ?? 'WATCHING_DISABLED';
  const todoPill = useTodoPillContent(session.todo === true);
  const alertButtonLabels = ALERT_BUTTON_LABELS[status];
  const showTodoPill = todoPill.visible;

  return (
    <div className="flex h-8 shrink-0 items-center gap-1.5 bg-header-active-bg pl-2 pr-[5px] font-mono text-sm leading-none text-header-active-fg">
      <div className="flex min-w-0 flex-1 items-center gap-1.5">
        <span className="min-w-0 shrink truncate font-medium">{session.title}</span>
        <HeaderActionButton
          className={[
            'flex h-5 min-w-5 items-center justify-center rounded transition-colors shrink-0 hover:bg-current/10',
            status === 'ALERT_RINGING' ? 'text-alarm-vs-header-active' : '',
          ].join(' ')}
          onClick={() => dismissOrToggleAlert(session.id, status)}
          ariaLabel={alertButtonLabels.aria}
          tooltip={alertButtonLabels.tooltip}
          tooltipAlign="left"
          dataAlertButtonFor={session.id}
        >
          <span className="flex items-center justify-center">
            {status === 'WATCHING_DISABLED' ? (
              <BellIcon size={14} />
            ) : (
              <BellIcon size={14} weight="fill" className={bellIconClass(status)} />
            )}
          </span>
        </HeaderActionButton>
        {session.secondary ? (
          <span className="min-w-0 shrink truncate opacity-70">{session.secondary}</span>
        ) : null}
      </div>
      {showTodoPill ? (
        <button
          type="button"
          data-session-todo-for={session.id}
          data-flourishing={todoPill.flourishing ? 'true' : 'false'}
          className={`todo-pill-shell shrink-0 rounded border border-current px-1.5 py-px text-xs font-semibold ${TODO_PILL_TRACKING_CLASS} transition-colors hover:bg-current/10 focus:outline-none`}
          aria-label="Dismiss TODO"
          aria-hidden={todoPill.flourishing ? true : undefined}
          onClick={(event) => {
            event.stopPropagation();
            clearSessionTodo(session.id);
          }}
        >
          {todoPill.body}
        </button>
      ) : null}
      <div className="ml-1 flex shrink-0 items-center gap-0.5">
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-current/10"
          onClick={onMinimize}
          ariaLabel="Minimize"
          tooltip="Minimize"
        >
          <ArrowLineDownIcon size={14} />
        </HeaderActionButton>
        <HeaderActionButton
          className="flex h-5 min-w-5 items-center justify-center rounded transition-colors hover:bg-error/10 hover:text-error"
          onClick={onKill}
          ariaLabel="Kill"
          tooltip="Kill"
        >
          <XIcon size={14} />
        </HeaderActionButton>
      </div>
    </div>
  );
}

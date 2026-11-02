import { useCallback, useEffect, useMemo, useState, useSyncExternalStore, type ReactNode } from 'react';
import { ArrowClockwiseIcon, BrowserIcon, CaretDownIcon, TerminalWindowIcon, XIcon } from '@phosphor-icons/react';
import { clsx } from 'clsx';
import { HeaderActionButton } from './HeaderActionButton';
import { TerminalPane } from './TerminalPane';
import { AlertRingInset, alertRingRow, useAlertRingBurst } from './alert-ring';
import { chromeButton, HEADER_PILL_CLASS, MOBILE_BAR_HEIGHT_CLASS } from './design';
import { useTodoPillContent } from './TodoPillBody';
import type { MobileSurfaceKind, MobileTerminalSessionItem } from './MobileTerminalUi';
import {
  clearSessionTodo,
  DEFAULT_ACTIVITY_STATE,
  disposeSession,
  getActivitySnapshot,
  getOrCreateTerminal,
  getTerminalPaneStateSnapshot,
  setTerminalUserTitle,
  subscribeToActivity,
  subscribeToTerminalPaneState,
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
  /** Absent reads as `terminal`. A `page` has no terminal to mount. */
  kind?: MobileSurfaceKind;
}

export interface MobileWallProps {
  sessions?: MobileWallSession[];
  /** Authoritative presentation, when the Session state lives on another machine. */
  sessionItems?: MobileTerminalSessionItem[];
  /** Null makes TODO display-only for a consumer with no dismissal capability. */
  onSessionTodoClear?: ((id: string) => void) | null;
  activeSessionId?: string;
  defaultActiveSessionId?: string;
  onActiveSessionChange?: (id: string) => void;
  /** Tapping the header's Session title asks for the Sessions screen; omitted, the title is plain text. */
  onShowSessions?: () => void;
  onSessionKill?: (id: string) => void;
  showKillButton?: boolean;
  /** What covers the active Session's terminal; omitted, nothing does. */
  page?: ReactNode;
  /** A Tool's choice of its page over its terminal, which its header switches. */
  pageShown?: boolean;
  onPageShownChange?: (shown: boolean) => void;
  /** Reloads the shown page; omitted, the header offers no reload. */
  onPageReload?: () => void;
  className?: string;
}

const DEFAULT_MOBILE_SESSION: MobileWallSession = { id: 'mobile-pane' };
const HEADER_BUTTON_CLASS = chromeButton({ kind: 'window', class: clsx(MOBILE_BAR_HEIGHT_CLASS, 'shrink-0') });


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
      kind: session.kind,
      title: primary === DEFAULT_IDLE_TITLE && session.title ? session.title : primary,
      secondary: derivedHeader.secondary,
      active: session.id === activeSessionId,
      status: activity.status,
      episode: activity.episode ?? null,
      todo: activity.todo,
    };
  }), [activeSessionId, activityStates, appTitleForPane, sessions, terminalStates, visiblePaneStates]);
}

export function MobileWall({
  sessions: controlledSessions,
  sessionItems: controlledSessionItems,
  onSessionTodoClear = clearSessionTodo,
  activeSessionId,
  defaultActiveSessionId,
  onActiveSessionChange,
  onShowSessions,
  onSessionKill,
  showKillButton = true,
  page,
  pageShown = false,
  onPageShownChange,
  onPageReload,
  className,
}: MobileWallProps) {
  const [internalSessions, setInternalSessions] = useState<MobileWallSession[]>(() => controlledSessions ?? [DEFAULT_MOBILE_SESSION]);
  const sessions = controlledSessions ?? internalSessions;
  const firstSessionId = sessions[0]?.id ?? null;
  const [internalActiveSessionId, setInternalActiveSessionId] = useState<string | null>(defaultActiveSessionId ?? firstSessionId);
  const resolvedActiveSessionId = activeSessionId ?? internalActiveSessionId ?? firstSessionId;
  const localSessionItems = useMobileWallSessionItems(sessions, resolvedActiveSessionId);
  const sessionItems = controlledSessionItems ?? localSessionItems;
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
      if (session.kind === 'page') continue;
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

  const showingPage = activeItem?.kind === 'page' || (activeItem?.kind === 'tool' && pageShown);

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
        onTodoClear={onSessionTodoClear ? () => onSessionTodoClear(activeItem.id) : undefined}
        onShowSessions={onShowSessions}
        onKill={() => killSession(activeItem.id)}
        showKillButton={showKillButton}
        showingPage={showingPage}
        onPageShownChange={activeItem.kind === 'tool' ? onPageShownChange : undefined}
        onPageReload={showingPage ? onPageReload : undefined}
      />
      {/* `MobileTerminalUi` acknowledges a touch or keystroke on this pane —
          the only way a ring goes out here (`docs/specs/alert.md` -> Pane Header). */}
      <div className="relative min-h-0 flex-1 overflow-hidden bg-terminal-bg">
        {activeItem.kind === 'page' ? null : <TerminalPane id={activeItem.id} isFocused={!showingPage} />}
        {/* Over a Tool's terminal rather than instead of it, which keeps its size.
            Past the safe area, as an iframe cannot read it for itself. */}
        <div
          className={clsx('absolute inset-0 pb-[env(safe-area-inset-bottom)]', !showingPage && 'invisible')}
          data-mobile-page-layer
        >
          {page}
        </div>
      </div>
    </div>
  );
}

function MobileWallHeader({
  session,
  onTodoClear,
  onShowSessions,
  onKill,
  showKillButton,
  showingPage,
  onPageShownChange,
  onPageReload,
}: {
  session: MobileTerminalSessionItem;
  onTodoClear?: () => void;
  onShowSessions?: () => void;
  onKill: () => void;
  showKillButton: boolean;
  showingPage: boolean;
  onPageShownChange?: (shown: boolean) => void;
  onPageReload?: () => void;
}) {
  const todoPill = useTodoPillContent(session.todo === true);
  const TodoPill = onTodoClear ? 'button' : 'span';
  const row = alertRingRow(session.status, null);
  const burst = useAlertRingBurst(row, session.episode);
  const Title = onShowSessions ? 'button' : 'div';

  return (
    <div className={clsx('relative flex shrink-0 items-center gap-1.5 overflow-hidden bg-header-active-bg font-mono text-sm leading-tight text-header-active-fg', MOBILE_BAR_HEIGHT_CLASS)}>
      <Title
        type={onShowSessions ? 'button' : undefined}
        title={onShowSessions ? 'Show sessions' : undefined}
        onClick={onShowSessions}
        className={clsx('flex h-full min-w-0 flex-1 items-center gap-1.5 px-2 text-left', onShowSessions && 'transition-colors hover:bg-current/10')}
      >
        <span className="min-w-0 shrink truncate font-medium">{session.title}</span>
        {session.secondary ? (
          <span className="min-w-0 shrink truncate opacity-70">{session.secondary}</span>
        ) : null}
        {onShowSessions ? (
          <CaretDownIcon size={10} weight="bold" className="shrink-0 opacity-65" aria-hidden="true" />
        ) : null}
      </Title>
      {todoPill.visible ? (
        <TodoPill
          type={onTodoClear ? 'button' : undefined}
          data-session-todo-for={session.id}
          data-flourishing={todoPill.flourishing ? 'true' : 'false'}
          className={clsx('todo-pill-shell', HEADER_PILL_CLASS, !showKillButton && 'mr-2')}
          aria-label={onTodoClear ? 'Dismiss TODO' : 'TODO'}
          aria-hidden={todoPill.flourishing ? true : undefined}
          onClick={onTodoClear ? (event) => {
            event.stopPropagation();
            onTodoClear();
          } : undefined}
        >
          {todoPill.body}
        </TodoPill>
      ) : null}
      {onPageReload ? (
        <HeaderActionButton className={HEADER_BUTTON_CLASS} onClick={onPageReload} ariaLabel="Reload page" tooltip="Reload page">
          <ArrowClockwiseIcon size={16} />
        </HeaderActionButton>
      ) : null}
      {onPageShownChange ? (
        <HeaderActionButton
          className={HEADER_BUTTON_CLASS}
          onClick={() => onPageShownChange(!showingPage)}
          ariaLabel={showingPage ? 'Show terminal' : 'Show page'}
          tooltip={showingPage ? 'Show terminal' : 'Show page'}
        >
          {showingPage ? <TerminalWindowIcon size={16} /> : <BrowserIcon size={16} />}
        </HeaderActionButton>
      ) : null}
      {showKillButton ? (
        <HeaderActionButton
          className={chromeButton({ kind: 'window', class: clsx(MOBILE_BAR_HEIGHT_CLASS, 'hover:bg-error/10 hover:text-error') })}
          onClick={onKill}
          ariaLabel="Kill"
          tooltip="Kill"
        >
          <XIcon size={16} />
        </HeaderActionButton>
      ) : null}
      {row && <AlertRingInset ground="header-active" burst={burst} />}
    </div>
  );
}

import {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type PointerEvent as ReactPointerEvent,
} from 'react';
import { clsx } from 'clsx';
import { PlusIcon, XIcon } from '@phosphor-icons/react';
import { AlertBell } from './AlertBell';
import { InlineEditInput } from './wall/InlineEditInput';
import { KillConfirmModal } from './KillConfirm';
import { useTodoPillContent } from './TodoPillBody';
import { chromeButton, TERMINAL_TOP_RADIUS_CLASS, TODO_PILL_TRACKING_CLASS } from './design';
import { createWorkspaceStripDrag } from './workspace-strip-drag';
import { acquireChromeKeyboardLease } from './wall/chrome-keyboard-lease';
import { acceptsKillChar } from './wall/keyboard/handle-kill-confirm';
import { useDialogKeyboardOwner } from './wall/wall-context';
import { closeWorkspaceWithSurfaces, requestWorkspaceClose, requestWorkspaceRename } from './wall/workspace-lifecycle';
import { getActivitySnapshot, subscribeToActivity } from '../lib/terminal-registry';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { computeWorkspaceUnion, EMPTY_WORKSPACE_UNION, type WorkspaceUnion } from '../lib/workspace-union';
import {
  getWorkspaceUiSnapshot,
  setPendingWorkspaceClose,
  setRenamingWorkspace,
  subscribeToWorkspaceUi,
} from '../lib/workspace-ui-store';
import {
  createWorkspace,
  getWorkspacesSnapshot,
  moveWorkspace,
  renameWorkspace,
  setActiveWorkspace,
  subscribeToWorkspaces,
} from '../lib/workspace-store';
import type { WorkspaceId } from '../lib/session-types';

/**
 * The Window's Workspace tabs. Store-driven end to end (Workspaces, membership,
 * Activity, and the strip's own UI state), so it renders in the AppBar — outside
 * every Wall's React tree — and shows the same rename editor and confirmation
 * whether the gesture came from a tab or from a command-mode key
 * (`docs/specs/layout.md` → "Workspaces"; `docs/specs/standalone.md` → AppBar).
 * The close verb itself lives in `wall/workspace-lifecycle.ts`; this renders it.
 */
export function WorkspaceStrip({
  className,
  onDragOutsideWindow,
  onDropOnOtherWindow,
}: {
  className?: string;
  /** PR C: the reorder drag left this Window's strip. */
  onDragOutsideWindow?: (id: WorkspaceId, point: { clientX: number; clientY: number }) => void;
  /** PR C: released over another Window; true means that Window took it. */
  onDropOnOtherWindow?: (id: WorkspaceId, point: { clientX: number; clientY: number }) => boolean;
}) {
  const { workspaces, activeId } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  const membership = useSyncExternalStore(subscribeToWorkspaceSurfaces, getWorkspaceSurfacesSnapshot);
  const activity = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const { renamingId, pendingClose } = useSyncExternalStore(subscribeToWorkspaceUi, getWorkspaceUiSnapshot);
  const [draggingId, setDraggingId] = useState<WorkspaceId | null>(null);

  const stripRef = useRef<HTMLDivElement>(null);
  const tabElementsRef = useRef(new Map<WorkspaceId, HTMLElement>());

  // The editor and the confirmation both sit outside every Wall, so a
  // capture-phase command-mode shortcut would still fire behind them.
  useDialogKeyboardOwner(renamingId !== null || pendingClose !== null, acquireChromeKeyboardLease);

  const activate = useCallback((id: WorkspaceId) => {
    setActiveWorkspace(id);
    tabElementsRef.current.get(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, []);

  // Stable across renders: the tab's own `data-workspace-tab` says which entry
  // it is, and the returned cleanup is what React 19 calls on detach.
  const registerElement = useCallback((element: HTMLElement | null) => {
    if (!element) return;
    const id = element.dataset.workspaceTab!;
    tabElementsRef.current.set(id, element);
    return () => { tabElementsRef.current.delete(id); };
  }, []);

  const finishRename = useCallback((id: WorkspaceId, value: string) => {
    renameWorkspace(id, value);
    setRenamingWorkspace(null);
  }, []);
  const cancelRename = useCallback(() => setRenamingWorkspace(null), []);

  // The PR C hooks are read through a ref refreshed each render, so a host that
  // supplies them after first paint is not captured stale by the controller.
  const windowHooksRef = useRef({ onDragOutsideWindow, onDropOnOtherWindow });
  windowHooksRef.current = { onDragOutsideWindow, onDropOnOtherWindow };

  const dragRef = useRef<ReturnType<typeof createWorkspaceStripDrag> | null>(null);
  if (dragRef.current === null) {
    dragRef.current = createWorkspaceStripDrag({
      order: () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id),
      tabElement: (id) => tabElementsRef.current.get(id) ?? null,
      stripRect: () => stripRef.current?.getBoundingClientRect() ?? null,
      move: (id, toIndex) => { moveWorkspace(id, toIndex); },
      setDragging: setDraggingId,
      onDragOutsideWindow: (id, point) => windowHooksRef.current.onDragOutsideWindow?.(id, point),
      onDropOnOtherWindow: (id, point) => windowHooksRef.current.onDropOnOtherWindow?.(id, point) ?? false,
    });
  }
  const drag = dragRef.current;
  useEffect(() => () => drag.dispose(), [drag]);
  const press = useCallback(
    (id: WorkspaceId, event: ReactPointerEvent<HTMLElement>) => drag.press(id, event.nativeEvent),
    [drag],
  );

  // The confirmation is a typed letter, exactly as a pane kill is, down to the
  // key rule: a case-insensitive match accepts and any other key dismisses. The
  // Wall's own handler is behind the chrome lease this dialog holds, so the
  // strip listens for itself.
  useEffect(() => {
    if (!pendingClose) return;
    const { id, char } = pendingClose;
    const onKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      setPendingWorkspaceClose(null);
      if (acceptsKillChar(event.key, char)) void closeWorkspaceWithSurfaces(id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [pendingClose]);

  // Anchored to the Window's content area, not the tab: a 24px tab is too small
  // a box to center a dialog over, and every Wall shares one grid cell, so the
  // confirmation lands in the same place whichever Workspace it is about. No
  // Window (Storybook) leaves it viewport-centered.
  const confirmTarget = useMemo(
    () => (pendingClose ? document.querySelector<HTMLElement>('[data-workspace-content]') : null),
    [pendingClose],
  );

  // One union per tab, computed in the loop it is rendered in. The visible
  // Workspace never shows indicators, so it skips the projection entirely.
  const unionsRef = useRef(new Map<WorkspaceId, WorkspaceUnion>());
  const unionFor = (id: WorkspaceId, active: boolean): WorkspaceUnion => {
    if (active) return EMPTY_WORKSPACE_UNION;
    const next = computeWorkspaceUnion(membership.get(id) ?? [], activity);
    // Hand back the previous object when nothing in it changed, so a memoized
    // tab re-renders only when its own indicators do.
    const previous = unionsRef.current.get(id);
    if (previous && previous.ringing === next.ringing && previous.todo === next.todo
      && previous.count === next.count && previous.ringSeq === next.ringSeq) return previous;
    unionsRef.current.set(id, next);
    return next;
  };

  return (
    <div ref={stripRef} className={clsx('flex min-w-0 items-center gap-0.5 overflow-x-auto', className)}>
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId;
        return (
          <WorkspaceTab
            key={workspace.id}
            id={workspace.id}
            name={workspace.name}
            active={isActive}
            union={unionFor(workspace.id, isActive)}
            renaming={renamingId === workspace.id}
            dragging={draggingId === workspace.id}
            closable={workspaces.length > 1}
            registerElement={registerElement}
            onActivate={activate}
            onStartRename={requestWorkspaceRename}
            onFinishRename={finishRename}
            onCancelRename={cancelRename}
            onRequestClose={requestWorkspaceClose}
            onPress={press}
            wasDragged={drag.dragged}
          />
        );
      })}
      <button
        type="button"
        data-workspace-new
        className={chromeButton({ kind: 'icon' })}
        aria-label="New workspace"
        title="New workspace"
        onClick={() => { createWorkspace(); }}
      >
        <PlusIcon size={12} weight="bold" aria-hidden="true" />
      </button>
      {pendingClose && (
        <KillConfirmModal
          char={pendingClose.char}
          targetElement={confirmTarget}
          onCancel={() => setPendingWorkspaceClose(null)}
        />
      )}
    </div>
  );
}

/** Memoized: every callback below is stable and takes the Workspace id, so a tab
 *  re-renders only when its own name, state, or union changes. */
const WorkspaceTab = memo(function WorkspaceTab({
  id,
  name,
  active,
  union,
  renaming,
  dragging,
  closable,
  registerElement,
  onActivate,
  onStartRename,
  onFinishRename,
  onCancelRename,
  onRequestClose,
  onPress,
  wasDragged,
}: {
  id: WorkspaceId;
  name: string;
  active: boolean;
  union: WorkspaceUnion;
  renaming: boolean;
  dragging: boolean;
  closable: boolean;
  registerElement: (element: HTMLElement | null) => (() => void) | undefined;
  onActivate: (id: WorkspaceId) => void;
  onStartRename: (id: WorkspaceId) => void;
  onFinishRename: (id: WorkspaceId, value: string) => void;
  onCancelRename: () => void;
  onRequestClose: (id: WorkspaceId) => void;
  onPress: (id: WorkspaceId, event: ReactPointerEvent<HTMLElement>) => void;
  wasDragged: () => boolean;
}) {
  const todoPill = useTodoPillContent(union.todo);
  // The visible Workspace shows its Surfaces, so its indicators would say what
  // the panes already say; only a hidden one needs them.
  const showIndicators = !active && (union.ringing || todoPill.visible);
  const label = showIndicators && union.count > 0 ? `${name}, ${union.count} needing attention` : name;

  return (
    <div
      ref={registerElement}
      data-workspace-tab={id}
      data-workspace-tab-active={active ? 'true' : 'false'}
      role="group"
      className={clsx(
        // Sized like a browser tab: 180px each until they crowd, then down to
        // 72px, then the strip scrolls. No overflow arrows.
        'group relative flex h-6 w-[180px] min-w-[72px] shrink items-center overflow-hidden text-xs font-medium',
        // The tab is the top of its Workspace exactly as a Door is the bottom of
        // its Surface, so the active one takes the terminal's top radius and the
        // wall's own palette — background AND foreground, or the bar's white
        // header text would sit on a light app background.
        active ? clsx('bg-app-bg text-app-fg', TERMINAL_TOP_RADIUS_CLASS) : 'hover:bg-current/10',
      )}
      style={dragging ? { opacity: 0.6 } : undefined}
      onPointerDown={(event) => {
        if (event.target instanceof Element && event.target.closest('[data-workspace-tab-close]')) return;
        onPress(id, event);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || !closable) return;
        event.preventDefault();
        onRequestClose(id);
      }}
    >
      {renaming ? (
        <InlineEditInput
          data-workspace-rename-for={id}
          initialValue={name}
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
          blurAction="submit"
          onSubmit={(value) => onFinishRename(id, value)}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-2 pr-1 text-left"
          aria-label={label}
          title={label}
          aria-current={active ? 'true' : undefined}
          onClick={() => { if (!wasDragged()) onActivate(id); }}
          onDoubleClick={() => onStartRename(id)}
        >
          <span className="min-w-0 flex-1 truncate">{name}</span>
          {showIndicators && (
            <span className="flex shrink-0 items-center gap-1.5">
              {todoPill.visible && (
                <span
                  className={`todo-pill-shell text-[10px] font-semibold ${TODO_PILL_TRACKING_CLASS}`}
                  data-flourishing={todoPill.flourishing ? 'true' : 'false'}
                >
                  {todoPill.body}
                </span>
              )}
              {/* An inactive tab sits on the app bar's header palette, not on a
                  Door, so the bell takes the header's alarm color. */}
              {union.ringing && (
                <span className="text-alarm-vs-header-active">
                  <AlertBell status="ALERT_RINGING" ringSeq={union.ringSeq} size={11} />
                </span>
              )}
            </span>
          )}
        </button>
      )}
      {closable && !renaming && (
        <button
          type="button"
          data-workspace-tab-close={id}
          className={clsx(
            'flex h-full shrink-0 items-center rounded px-1 hover:bg-current/10',
            // Always on the active tab; on the others only while pointed at or
            // focused, so a row of tabs is not a row of close buttons.
            active ? '' : 'opacity-0 group-hover:opacity-100 focus-visible:opacity-100',
          )}
          aria-label={`Close ${name}`}
          title={`Close ${name}`}
          onClick={(event) => {
            event.stopPropagation();
            onRequestClose(id);
          }}
        >
          <XIcon size={11} weight="bold" aria-hidden="true" />
        </button>
      )}
    </div>
  );
});

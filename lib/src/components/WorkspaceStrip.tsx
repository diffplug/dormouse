import {
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
import { KillConfirmModal, randomKillChar } from './KillConfirm';
import { useTodoPillContent } from './TodoPillBody';
import { chromeButton, TERMINAL_TOP_RADIUS_CLASS, TODO_PILL_TRACKING_CLASS } from './design';
import { createWorkspaceStripDrag } from './workspace-strip-drag';
import { getWallHandle } from './wall/wall-handles';
import { acquireChromeKeyboardLease } from '../lib/chrome-keyboard-lease';
import { forgetWorkspaceSession } from '../lib/window-session-aggregator';
import { getActivitySnapshot, subscribeToActivity } from '../lib/terminal-registry';
import { clearWorkspaceSurfaces, getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { computeWorkspaceUnion, EMPTY_WORKSPACE_UNION, type WorkspaceUnion } from '../lib/workspace-union';
import { subscribeToWorkspaceStripIntent } from '../lib/workspace-strip-intent';
import {
  closeWorkspace,
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
 * Activity), so it renders in the AppBar — outside every Wall's React tree
 * (`docs/specs/layout.md` → "Workspaces"; `docs/specs/standalone.md` → AppBar).
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
  const [renamingId, setRenamingId] = useState<WorkspaceId | null>(null);
  const [draggingId, setDraggingId] = useState<WorkspaceId | null>(null);
  const [confirmClose, setConfirmClose] = useState<{ id: WorkspaceId; char: string } | null>(null);

  const stripRef = useRef<HTMLDivElement>(null);
  const tabElementsRef = useRef(new Map<WorkspaceId, HTMLElement>());

  const unions = useMemo(() => {
    const byId = new Map<WorkspaceId, WorkspaceUnion>();
    for (const workspace of workspaces) {
      const ids = membership.get(workspace.id);
      byId.set(workspace.id, ids ? computeWorkspaceUnion(ids, activity) : EMPTY_WORKSPACE_UNION);
    }
    return byId;
  }, [workspaces, membership, activity]);

  // The editor and the confirmation both sit outside every Wall, so a
  // capture-phase command-mode shortcut would still fire behind them.
  const keyboardHeld = renamingId !== null || confirmClose !== null;
  useEffect(() => (keyboardHeld ? acquireChromeKeyboardLease() : undefined), [keyboardHeld]);

  const activate = useCallback((id: WorkspaceId) => {
    setActiveWorkspace(id);
    tabElementsRef.current.get(id)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, []);

  /**
   * Close a Workspace: confirm first when it holds work, then close every member
   * Surface through the closure coordinator, then drop the Workspace itself. A
   * refusal reveals the Workspace so its prompt is visible.
   */
  const closeNow = useCallback(async (id: WorkspaceId) => {
    const handle = getWallHandle(id);
    if (handle) {
      const refusal = await handle.closeAll('prompt');
      if (refusal) {
        setActiveWorkspace(id);
        return;
      }
    }
    clearWorkspaceSurfaces(id);
    forgetWorkspaceSession(id);
    closeWorkspace(id);
  }, []);

  const requestClose = useCallback((id: WorkspaceId) => {
    // The last Workspace never closes — there is always one active
    // (docs/specs/glossary.md → Workspace lifecycle).
    if (getWorkspacesSnapshot().workspaces.length <= 1) return;
    const handle = getWallHandle(id);
    if (handle && (handle.hasTouchedSurfaces() || handle.runningCount() > 0)) {
      setConfirmClose({ id, char: randomKillChar() });
      return;
    }
    void closeNow(id);
  }, [closeNow]);

  const dragRef = useRef<ReturnType<typeof createWorkspaceStripDrag> | null>(null);
  if (dragRef.current === null) {
    dragRef.current = createWorkspaceStripDrag({
      order: () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id),
      tabElement: (id) => tabElementsRef.current.get(id) ?? null,
      stripRect: () => stripRef.current?.getBoundingClientRect() ?? null,
      move: (id, toIndex) => { moveWorkspace(id, toIndex); },
      setDragging: setDraggingId,
      onDragOutsideWindow,
      onDropOnOtherWindow,
    });
  }
  const drag = dragRef.current;
  useEffect(() => () => drag.dispose(), [drag]);

  // `&` and `$` in command mode reach the strip's own affordances, which live
  // out here rather than in the Wall that heard the key.
  useEffect(() => subscribeToWorkspaceStripIntent((intent) => {
    if (intent.kind === 'close') requestClose(intent.workspaceId);
    else setRenamingId(intent.workspaceId);
  }), [requestClose]);

  // The confirmation is a typed letter, exactly as a pane kill is. The Wall's
  // own handler is behind the chrome lease this dialog holds, so the strip
  // listens for its own char.
  useEffect(() => {
    if (!confirmClose) return;
    const { id, char } = confirmClose;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== char) return;
      event.preventDefault();
      event.stopPropagation();
      setConfirmClose(null);
      void closeNow(id);
    };
    window.addEventListener('keydown', onKeyDown, true);
    return () => window.removeEventListener('keydown', onKeyDown, true);
  }, [confirmClose, closeNow]);

  // Anchored to the Workspace's own Wall, not its tab: a 24px tab is too small a
  // box to center a dialog over, and every Wall shares one grid cell, so the
  // confirmation lands in the same place whether or not that Workspace is
  // visible. No Wall (Storybook) leaves it viewport-centered.
  const confirmTarget = confirmClose
    ? [...document.querySelectorAll<HTMLElement>('[data-workspace-wall]')]
      .find((wall) => wall.dataset.workspaceWall === confirmClose.id) ?? null
    : null;

  return (
    <div ref={stripRef} className={clsx('flex min-w-0 items-center gap-0.5 overflow-x-auto', className)}>
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId;
        const union = unions.get(workspace.id) ?? EMPTY_WORKSPACE_UNION;
        return (
          <WorkspaceTab
            key={workspace.id}
            id={workspace.id}
            name={workspace.name}
            active={isActive}
            union={union}
            renaming={renamingId === workspace.id}
            dragging={draggingId === workspace.id}
            closable={workspaces.length > 1}
            registerElement={(element) => {
              if (element) tabElementsRef.current.set(workspace.id, element);
              else tabElementsRef.current.delete(workspace.id);
              return undefined;
            }}
            onActivate={() => activate(workspace.id)}
            onStartRename={() => setRenamingId(workspace.id)}
            onFinishRename={(value) => {
              renameWorkspace(workspace.id, value);
              setRenamingId(null);
            }}
            onCancelRename={() => setRenamingId(null)}
            onRequestClose={() => requestClose(workspace.id)}
            onPress={(event) => drag.press(workspace.id, event.nativeEvent)}
            wasDragged={() => drag.dragged()}
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
      {confirmClose && (
        <KillConfirmModal
          char={confirmClose.char}
          targetElement={confirmTarget}
          onCancel={() => setConfirmClose(null)}
        />
      )}
    </div>
  );
}

function WorkspaceTab({
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
  registerElement: (element: HTMLElement | null) => void;
  onActivate: () => void;
  onStartRename: () => void;
  onFinishRename: (value: string) => void;
  onCancelRename: () => void;
  onRequestClose: () => void;
  onPress: (event: ReactPointerEvent<HTMLElement>) => void;
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
        onPress(event);
      }}
      onAuxClick={(event) => {
        if (event.button !== 1 || !closable) return;
        event.preventDefault();
        onRequestClose();
      }}
    >
      {renaming ? (
        <InlineEditInput
          data-workspace-rename-for={id}
          initialValue={name}
          className="h-full min-w-0 flex-1 bg-transparent px-2 text-xs outline-none"
          blurAction="submit"
          onSubmit={(value) => onFinishRename(value)}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          type="button"
          className="flex h-full min-w-0 flex-1 items-center gap-1.5 overflow-hidden pl-2 pr-1 text-left"
          aria-label={label}
          title={label}
          aria-current={active ? 'true' : undefined}
          onClick={() => { if (!wasDragged()) onActivate(); }}
          onDoubleClick={onStartRename}
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
            onRequestClose();
          }}
        >
          <XIcon size={11} weight="bold" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

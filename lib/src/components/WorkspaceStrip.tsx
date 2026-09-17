import { WorkspaceRingCues, type WorkspaceRingCue } from '../lib/workspace-ring-cues';
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
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
import { WorkspaceKillConfirm } from './WorkspaceKillConfirm';
import { useTodoPillContent } from './TodoPillBody';
import { chromeButton, DOOR_TAB_CLASS, HEADER_PALETTE_TRANSITION_CLASS, TODO_PILL_TRACKING_CLASS } from './design';
import { createWorkspaceStripDrag, type StripDragHost } from './workspace-strip-drag';
import { acquireChromeKeyboardLease } from './wall/chrome-keyboard-lease';
import { useDialogKeyboardOwner } from './wall/wall-context';
import { closeWorkspaceWithSurfaces, requestWorkspaceClose, requestWorkspaceRename } from './wall/workspace-lifecycle';
import { getActivitySnapshot, subscribeToActivity } from '../lib/terminal-registry';
import { getWorkspaceSurfacesSnapshot, subscribeToWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { computeWorkspaceUnion, EMPTY_WORKSPACE_UNION, type WorkspaceUnion } from '../lib/workspace-union';
import { isWorkspaceTransferPending } from '../lib/window-session-aggregator';
import {
  getWorkspaceUiSnapshot,
  setPendingWorkspaceClose,
  setPendingWorkspaceMove,
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
  onDragBackInsideStrip,
  onDropOnOtherWindow,
  onDragCancelled,
}: {
  className?: string;
  /** The three cross-Window drag hooks (`StripDragHost`). A composition with no
   *  Windows — Storybook, the website playground — supplies none. */
  onDragOutsideWindow?: StripDragHost['onDragOutsideWindow'];
  onDragBackInsideStrip?: StripDragHost['onDragBackInsideStrip'];
  onDropOnOtherWindow?: StripDragHost['onDropOnOtherWindow'];
  onDragCancelled?: StripDragHost['onDragCancelled'];
}) {
  const { workspaces, activeId } = useSyncExternalStore(subscribeToWorkspaces, getWorkspacesSnapshot);
  const membership = useSyncExternalStore(subscribeToWorkspaceSurfaces, getWorkspaceSurfacesSnapshot);
  const activity = useSyncExternalStore(subscribeToActivity, getActivitySnapshot);
  const { renamingId, pendingClose, pendingMove } = useSyncExternalStore(subscribeToWorkspaceUi, getWorkspaceUiSnapshot);
  const [draggingId, setDraggingId] = useState<WorkspaceId | null>(null);

  const stripRef = useRef<HTMLDivElement>(null);
  const tabElementsRef = useRef(new Map<WorkspaceId, HTMLElement>());

  // The editor and the confirmation both sit outside every Wall, so a
  // capture-phase command-mode shortcut would still fire behind them.
  useDialogKeyboardOwner(renamingId !== null || pendingClose !== null || pendingMove !== null, acquireChromeKeyboardLease);

  const activate = useCallback((id: WorkspaceId) => {
    setActiveWorkspace(id);
  }, []);

  // Activation changes the close button and therefore the intrinsic tab width.
  // Reveal it after layout, including activation through a shortcut or create.
  useLayoutEffect(() => {
    tabElementsRef.current.get(activeId)?.scrollIntoView?.({ block: 'nearest', inline: 'nearest' });
  }, [activeId]);

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

  // The cross-Window hooks are read through a ref refreshed each render, so a
  // host that supplies them after first paint is not captured stale by the
  // controller.
  const windowHooksRef = useRef({ onDragOutsideWindow, onDragBackInsideStrip, onDropOnOtherWindow, onDragCancelled });
  windowHooksRef.current = { onDragOutsideWindow, onDragBackInsideStrip, onDropOnOtherWindow, onDragCancelled };

  const dragRef = useRef<ReturnType<typeof createWorkspaceStripDrag> | null>(null);
  if (dragRef.current === null) {
    dragRef.current = createWorkspaceStripDrag({
      order: () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id),
      tabElement: (id) => tabElementsRef.current.get(id) ?? null,
      stripRect: () => stripRef.current?.getBoundingClientRect() ?? null,
      move: (id, toIndex) => { moveWorkspace(id, toIndex); },
      setDragging: setDraggingId,
      onDragOutsideWindow: (point) => windowHooksRef.current.onDragOutsideWindow?.(point),
      onDragBackInsideStrip: () => windowHooksRef.current.onDragBackInsideStrip?.(),
      onDropOnOtherWindow: (id, point, insideStrip) =>
        windowHooksRef.current.onDropOnOtherWindow?.(id, point, insideStrip),
      onDragCancelled: () => windowHooksRef.current.onDragCancelled?.(),
    });
  }
  const drag = dragRef.current;
  useEffect(() => () => drag.dispose(), [drag]);
  const press = useCallback(
    (id: WorkspaceId, event: ReactPointerEvent<HTMLElement>) => drag.press(id, event.nativeEvent),
    [drag],
  );

  // Anchored to the Window's content area, not the tab: a 24px tab is too small
  // a box to center a dialog over, and every Wall shares one grid cell, so the
  // confirmation lands in the same place whichever Workspace it is about. No
  // Window (Storybook) leaves it viewport-centered.
  const confirmTarget = useMemo(
    () => (pendingClose || pendingMove ? document.querySelector<HTMLElement>('[data-workspace-content]') : null),
    [pendingClose, pendingMove],
  );

  // Cues observe the active Workspace too, so switching tabs cannot create one.
  const ringCues = useRef(new WorkspaceRingCues());
  ringCues.current.update(workspaces.map(workspace => workspace.id), membership, activity);
  // One union per tab, computed in the loop it is rendered in. The visible
  // Workspace never shows indicators, so it skips the projection entirely.
  const unionsRef = useRef(new Map<WorkspaceId, WorkspaceUnion>());
  // Closed Workspaces leave the strip and must leave this cache with them, or a
  // long session accumulates one entry per Workspace it ever had.
  for (const id of unionsRef.current.keys()) {
    if (!workspaces.some((workspace) => workspace.id === id)) unionsRef.current.delete(id);
  }
  const unionFor = (id: WorkspaceId, active: boolean): WorkspaceUnion => {
    if (active) return EMPTY_WORKSPACE_UNION;
    const next = computeWorkspaceUnion(membership.get(id) ?? [], activity);
    // Hand back the previous object when nothing in it changed, so a memoized
    // tab re-renders only when its own indicators do.
    const previous = unionsRef.current.get(id);
    if (previous && previous.ringing === next.ringing && previous.todo === next.todo
      && previous.count === next.count) return previous;
    unionsRef.current.set(id, next);
    return next;
  };

  return (
    <div
      ref={stripRef}
      data-workspace-strip
      className={clsx('flex min-w-0 items-end gap-1.5 overflow-x-auto', className)}
    >
      {workspaces.map((workspace) => {
        const isActive = workspace.id === activeId;
        return (
          <WorkspaceTab
            key={workspace.id}
            id={workspace.id}
            name={workspace.name}
            active={isActive}
            union={unionFor(workspace.id, isActive)}
            ringCue={ringCues.current.get(workspace.id)}
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
        className={chromeButton({ kind: 'icon', class: 'mb-0.5 shrink-0' })}
        aria-label="New workspace"
        title="New workspace"
        onClick={() => { createWorkspace(); }}
      >
        <PlusIcon size={12} weight="bold" aria-hidden="true" />
      </button>
      {/* Rename owns its input until it ends; both typed gates wait behind it.
          The move gate is the same typed letter (the page state it destroys is
          as gone as a killed pane's process) and waits behind a close, so only
          one gate ever listens for the letter on screen. */}
      {pendingClose && !renamingId && (
        <WorkspaceKillConfirm
          char={pendingClose.char}
          detail={workspaces.find(workspace => workspace.id === pendingClose.id)?.name}
          canConfirm={() => !isWorkspaceTransferPending(pendingClose.id)}
          onConfirm={() => {
            const id = pendingClose.id;
            setPendingWorkspaceClose(null);
            void closeWorkspaceWithSurfaces(id);
          }}
          targetElement={confirmTarget}
          onCancel={() => setPendingWorkspaceClose(null)}
        />
      )}
      {pendingMove && !pendingClose && !renamingId && (
        <WorkspaceKillConfirm
          char={pendingMove.char}
          targetElement={confirmTarget}
          title="Move and lose page state?"
          detail={`${pendingMove.iframeCount === 1 ? 'An iframe Surface' : `${pendingMove.iframeCount} iframe Surfaces`} in this Workspace will reload at ${pendingMove.iframeCount === 1 ? 'its' : 'their'} saved URL; a page cannot leave its window.`}
          onConfirm={() => {
            const { proceed } = pendingMove;
            setPendingWorkspaceMove(null);
            proceed();
          }}
          onCancel={() => setPendingWorkspaceMove(null)}
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
  ringCue,
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
  ringCue: WorkspaceRingCue;
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
        DOOR_TAB_CLASS,
        HEADER_PALETTE_TRANSITION_CLASS,
        'w-max shrink',
        active ? 'bg-header-active-bg text-header-active-fg' : 'bg-header-inactive-bg text-header-inactive-fg',
      )}
      style={dragging ? { opacity: 0.6 } : undefined}
      onPointerDown={(event) => {
        // The close button has its own click, and a press inside the open rename
        // editor is a text selection — neither may start a reorder drag.
        if (renaming) return;
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
          className="h-full min-w-0 flex-1 bg-transparent px-2.5 text-sm outline-none"
          blurAction="submit"
          onSubmit={(value) => onFinishRename(id, value)}
          onCancel={onCancelRename}
        />
      ) : (
        <button
          type="button"
          className={clsx(
            'flex h-full min-w-0 flex-1 items-center gap-2 overflow-hidden pl-2.5 text-left',
            active && closable ? 'pr-1' : 'pr-2.5',
          )}
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
                  className={`todo-pill-shell text-xs font-semibold ${TODO_PILL_TRACKING_CLASS}`}
                  data-flourishing={todoPill.flourishing ? 'true' : 'false'}
                >
                  {todoPill.body}
                </span>
              )}
              {union.ringing && (
                <span className="text-alarm-vs-header-inactive">
                  <AlertBell status="ALERT_RINGING" ringSeq={ringCue.sequence} ringStartedAt={ringCue.at} size={11} />
                </span>
              )}
            </span>
          )}
        </button>
      )}
      {active && closable && !renaming && (
        <button
          type="button"
          data-workspace-tab-close={id}
          className="flex h-full shrink-0 items-center rounded pl-0.5 pr-2 hover:bg-current/10"
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

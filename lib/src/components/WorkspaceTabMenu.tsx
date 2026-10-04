import { useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { clsx } from 'clsx';
import { MODAL_LAYERS, OVERLAY_MAX_HEIGHT, POPUP_MENU_ITEM_CLASS, PopupButtonRow, portalToBody, useMeasuredElementRect } from './design';
import { useCloseOnOutsideAndEscape } from './use-anchored-menu';
import { workspaceTabElement } from './workspace-tab-elements';
import { pinWorkspace, requestWorkspaceClose, requestWorkspaceRename } from './wall/workspace-lifecycle';
import { writeTextToClipboard } from '../lib/clipboard';
import { clampOverlayPosition } from '../lib/ui-geometry';
import { closeWorkspaceMenu, type WorkspaceMenu } from '../lib/workspace-ui-store';
import { resumeAutoWorkspaceName, workspaceRefFor, type WorkspaceMeta } from '../lib/workspace-store';
import type { WorkspaceId } from '../lib/session-types';

interface MenuItem {
  key: string;
  label: string;
  /** Shown muted at the row's end. */
  hint?: string;
  /** Why the row does nothing, which also makes it inert. */
  disabledReason?: string;
  separatorBefore?: boolean;
  /** False when the action puts focus somewhere itself (the rename editor). */
  restoresFocus?: boolean;
  run: () => void;
}

/** The tab's activation button, which a keyboard-opened menu hands focus back
 *  to. Looked up by id: pinning moves the tab into the other group, which
 *  remounts it. */
function tabButton(id: WorkspaceId): HTMLElement | null {
  return workspaceTabElement(id)?.querySelector<HTMLElement>('button') ?? null;
}

/**
 * A Workspace tab's context menu (`docs/specs/layout.md` → "Workspace tabs").
 * Every row runs an existing Workspace verb, so a gesture here and the matching
 * `dor workspace` command take one path. Opened from the store
 * (`openWorkspaceMenu`), which also dismisses it whenever a rename,
 * confirmation, close, or move starts.
 */
export function WorkspaceTabMenu({
  menu,
  workspace,
  onMoveToNewWindow,
}: {
  menu: WorkspaceMenu;
  workspace: WorkspaceMeta;
  /** The host's tear-out into a new window; absent on a host with one window. */
  onMoveToNewWindow?: (id: WorkspaceId) => void;
}) {
  const { id } = workspace;
  const pinned = workspace.pinned === true;
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [menuEl, setMenuEl] = useState<HTMLDivElement | null>(null);
  const rect = useMeasuredElementRect(menuEl);
  // What a mouse-opened menu hands focus back to: whatever held it before.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const anchorRef = useRef<HTMLElement | null>(workspaceTabElement(id));

  const restoreFocus = () => (menu.keyboard ? tabButton(id) : opener)?.focus({ preventScroll: true });
  useCloseOnOutsideAndEscape(true, menuRef, closeWorkspaceMenu, anchorRef);

  const items: MenuItem[] = [
    { key: 'rename', label: 'Rename', restoresFocus: false, run: () => requestWorkspaceRename(id) },
    ...(workspace.nameIsAuto ? [] : [{ key: 'auto-name', label: 'Use automatic name', run: () => resumeAutoWorkspaceName(id) }]),
    { key: 'pin', label: pinned ? 'Unpin' : 'Pin right', run: () => { pinWorkspace(id, !pinned); } },
    { key: 'copy-ref', label: 'Copy ref', hint: workspaceRefFor(id), run: () => { void writeTextToClipboard(workspaceRefFor(id)); } },
    ...(onMoveToNewWindow ? [{ key: 'new-window', label: 'Move to new window', run: () => onMoveToNewWindow(id) }] : []),
    {
      key: 'close',
      label: 'Close',
      separatorBefore: true,
      disabledReason: pinned ? 'Pinned: unpin to close' : undefined,
      run: () => requestWorkspaceClose(id),
    },
  ];

  const activate = (item: MenuItem) => {
    if (item.disabledReason) return;
    // Committed before focus returns, so a pinned tab's remount is in place.
    flushSync(() => {
      closeWorkspaceMenu();
      item.run();
    });
    if (item.restoresFocus !== false) restoreFocus();
  };

  // Focus the first row once the menu is measured and visible: a hidden element
  // cannot take focus.
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!rect || focused.current) return;
    focused.current = true;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [rect]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    const index = rows.indexOf(document.activeElement as HTMLElement);
    let next: number | null = null;
    switch (event.key) {
      case 'ArrowDown': next = (index + 1) % rows.length; break;
      case 'ArrowUp': next = (index - 1 + rows.length) % rows.length; break;
      case 'Home': next = 0; break;
      case 'End': next = rows.length - 1; break;
      case 'Escape':
      case 'Tab':
        event.preventDefault();
        event.stopPropagation();
        closeWorkspaceMenu();
        restoreFocus();
        return;
      default:
        return;
    }
    event.preventDefault();
    event.stopPropagation();
    rows[next]?.focus({ preventScroll: true });
  };

  const style: CSSProperties = {
    zIndex: MODAL_LAYERS.app,
    ...(rect
      ? clampOverlayPosition({ left: menu.at.x, top: menu.at.y, width: rect.width, height: rect.height })
      : { position: 'fixed', left: 0, top: 0, visibility: 'hidden' }),
  };

  return portalToBody(
    <PopupButtonRow
      ref={(element: HTMLDivElement | null) => { menuRef.current = element; setMenuEl(element); }}
      role="menu"
      aria-label={`${workspace.name} actions`}
      data-workspace-menu-for={id}
      className={clsx('min-w-44 flex-col py-1', OVERLAY_MAX_HEIGHT.popover)}
      style={style}
      onKeyDown={onKeyDown}
      // A keyboard-opened menu takes focus before the browser's own context
      // menu event lands on it.
      onContextMenu={(event) => event.preventDefault()}
    >
      {items.map((item) => (
        <div key={item.key} className="contents">
          {item.separatorBefore && <div role="separator" className="my-1 border-t border-border" />}
          <button
            type="button"
            role="menuitem"
            tabIndex={-1}
            data-workspace-menu-item={item.key}
            aria-disabled={item.disabledReason ? true : undefined}
            aria-description={item.disabledReason}
            title={item.disabledReason}
            className={POPUP_MENU_ITEM_CLASS}
            onClick={() => activate(item)}
          >
            <span className="min-w-0 flex-1 truncate">{item.label}</span>
            {item.hint && <span className="shrink-0 pl-4 text-muted">{item.hint}</span>}
          </button>
        </div>
      ))}
    </PopupButtonRow>,
  );
}

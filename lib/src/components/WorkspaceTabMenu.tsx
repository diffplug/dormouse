import { useLayoutEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { flushSync } from 'react-dom';
import { clsx } from 'clsx';
import { OVERLAY_MAX_HEIGHT, POPUP_MENU_ITEM_CLASS, PopupButtonRow, portalToBody } from './design';
import { useAnchoredMenu, useCloseOnOutsideAndEscape } from './use-anchored-menu';
import { workspaceTabElement } from './workspace-tab-elements';
import { nameWorkspace, pinWorkspace, requestWorkspaceClose, requestWorkspaceRename, workspaceCloseRefusal } from './wall/workspace-lifecycle';
import { stepFocus } from './focus-step';
import { writeTextToClipboard } from '../lib/clipboard';
import { closeWorkspaceMenu, type WorkspaceMenu } from '../lib/workspace-ui-store';
import { workspaceRefFor, type WorkspaceMeta } from '../lib/workspace-store';
import type { WorkspaceId } from '../lib/session-types';

/** Fixed for the anchor's start/end flip; a long ref truncates. */
const MENU_WIDTH_PX = 224;

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
  const pinned = !!workspace.pinned;
  const menuRef = useRef<HTMLDivElement | null>(null);
  // What a mouse-opened menu hands focus back to: whatever held it before.
  const [opener] = useState(() => (document.activeElement instanceof HTMLElement ? document.activeElement : null));
  const anchorRef = useRef<HTMLElement | null>(workspaceTabElement(id));
  // Under the tab, left edges aligned, or right edges where the menu would run
  // off the window's right (a pinned tab at the title bar's end).
  const { setTriggerEl, setMenuEl, menuStyle } = useAnchoredMenu(true, MENU_WIDTH_PX, { align: 'auto' });
  useLayoutEffect(() => setTriggerEl(anchorRef.current), [setTriggerEl]);
  const placed = menuStyle.visibility !== 'hidden';

  const restoreFocus = () => (menu.keyboard ? tabButton(id) : opener)?.focus({ preventScroll: true });
  useCloseOnOutsideAndEscape(true, menuRef, closeWorkspaceMenu, anchorRef);

  const items: MenuItem[] = [
    { key: 'rename', label: 'Rename', restoresFocus: false, run: () => requestWorkspaceRename(id) },
    ...(workspace.nameIsAuto ? [] : [{ key: 'auto-name', label: 'Use automatic name', run: () => { nameWorkspace(id, null); } }]),
    { key: 'pin', label: pinned ? 'Unpin' : 'Pin right', run: () => { pinWorkspace(id, !pinned); } },
    { key: 'copy-ref', label: 'Copy ref', hint: workspaceRefFor(id), run: () => { void writeTextToClipboard(workspaceRefFor(id)); } },
    ...(onMoveToNewWindow ? [{ key: 'new-window', label: 'Move to new window', run: () => onMoveToNewWindow(id) }] : []),
    {
      key: 'close',
      label: 'Close',
      separatorBefore: true,
      disabledReason: workspaceCloseRefusal(id) ?? undefined,
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

  // Focus the first row once the menu is placed and visible: a hidden element
  // cannot take focus.
  const focused = useRef(false);
  useLayoutEffect(() => {
    if (!placed || focused.current) return;
    focused.current = true;
    menuRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus({ preventScroll: true });
  }, [placed]);

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const rows = [...(menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])];
    switch (event.key) {
      case 'ArrowDown': stepFocus(rows, 1); break;
      case 'ArrowUp': stepFocus(rows, -1); break;
      case 'Home': rows[0]?.focus({ preventScroll: true }); break;
      case 'End': rows[rows.length - 1]?.focus({ preventScroll: true }); break;
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
  };

  return portalToBody(
    <PopupButtonRow
      ref={(element: HTMLDivElement | null) => { menuRef.current = element; setMenuEl(element); }}
      role="menu"
      aria-label={`${workspace.name} actions`}
      data-workspace-menu-for={id}
      className={clsx('flex-col py-1', OVERLAY_MAX_HEIGHT.popover)}
      style={menuStyle}
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
            {item.hint && <span className="min-w-0 shrink truncate pl-4 text-muted">{item.hint}</span>}
          </button>
        </div>
      ))}
    </PopupButtonRow>,
  );
}

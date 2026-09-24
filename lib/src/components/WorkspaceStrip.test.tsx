/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkspaceStrip } from './WorkspaceStrip';
import { chromeKeyboardHeld, resetChromeKeyboardLeases } from './wall/chrome-keyboard-lease';
import { registerWallHandle, resetWallHandles, stubWallHandle, type WallHandle } from './wall/wall-handles';
import { ensureResizeObserver } from './wall/wall-test-utils';
import { requestWorkspaceClose, requestWorkspaceRename } from './wall/workspace-lifecycle';
import { resetWorkspaceSurfaces, setWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { clearTerminalActivity, setTerminalActivity } from '../lib/terminal-registry';
import { createAlertEpisode } from '../lib/alert-episode';
import { resetWindowSessionAggregator, setWorkspaceTransferPending } from '../lib/window-session-aggregator';
import {
  getWorkspaceUiSnapshot,
  dismissWorkspaceUi,
  resetWorkspaceUi,
  setPendingWorkspaceClose,
  setPendingWorkspaceMove,
  setWorkspaceMoveError,
} from '../lib/workspace-ui-store';
import {
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
  setAutoWorkspaceName,
} from '../lib/workspace-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

function stubHandle(workspaceId: string, overrides: Partial<WallHandle> = {}): WallHandle {
  const handle = stubWallHandle(workspaceId, overrides);
  registerWallHandle(handle);
  return handle;
}

function tabs(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-workspace-tab]')];
}

function tabNames(): string[] {
  return tabs().map((tab) => tab.querySelector('span')!.textContent!);
}

function tabFor(id: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-workspace-tab="${id}"]`)!;
}

function activateButton(id: string): HTMLButtonElement {
  return tabFor(id).querySelector<HTMLButtonElement>('button')!;
}

function todoPill(id: string): HTMLButtonElement | null {
  return tabFor(id).querySelector<HTMLButtonElement>('[data-workspace-tab-todo]');
}

async function render(node = <WorkspaceStrip />): Promise<void> {
  await act(async () => root.render(node));
}

function pointer(type: string, init: Partial<PointerEvent> = {}): PointerEvent {
  return new MouseEvent(type, { bubbles: true, cancelable: true, ...init }) as unknown as PointerEvent;
}

/** React tracks a controlled input's value, so a plain assignment is invisible
 *  to `onChange`; go through the prototype setter it patched. */
function typeInto(input: HTMLInputElement, value: string): void {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

beforeEach(() => {
  ensureResizeObserver();
  resetWorkspaces();
  resetWorkspaceUi();
  resetWindowSessionAggregator();
  resetWorkspaceSurfaces();
  resetWallHandles();
  resetChromeKeyboardLeases();
  clearTerminalActivity();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('WorkspaceStrip', () => {
  it('renders a tab per Workspace, marks the active one, and creates from +', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    expect(tabNames()).toEqual(['Workspace 1']);
    expect(tabFor(first).dataset.workspaceTabActive).toBe('true');

    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-workspace-new]')!.click();
    });
    expect(tabNames()).toEqual(['Workspace 1', 'Workspace 2']);
    expect(tabFor(first).dataset.workspaceTabActive).toBe('false');
  });

  it('activates on click', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await render();
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(tabFor(first).querySelector('[data-workspace-tab-close]')).toBeNull();
    expect(tabFor('ws-2').querySelector('[data-workspace-tab-close]')).not.toBeNull();
    await act(async () => { activateButton(first).click(); });
    expect(getActiveWorkspaceId()).toBe(first);
    expect(tabFor(first).querySelector('[data-workspace-tab-close]')).not.toBeNull();
    expect(tabFor('ws-2').querySelector('[data-workspace-tab-close]')).toBeNull();
  });

  it('shows the TODO pill on every tab and the alarm inset on hidden ones, counting them in the label', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a', 'pane-b']);
    setWorkspaceSurfaces('ws-2', ['pane-c', 'pane-d']);
    setTerminalActivity('pane-a', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    setTerminalActivity('pane-b', { todo: true });
    setTerminalActivity('pane-c', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    await render();

    expect(activateButton(first).getAttribute('aria-label')).toBe('Workspace 1, 2 needing attention');
    expect(tabFor(first).querySelector('.todo-pill-shell')).not.toBeNull();
    expect(tabFor(first).querySelector('[data-alert-ring-inset]')).not.toBeNull();
    // The visible Workspace's panes ring for it, so its tab wears no inset, and
    // with no TODO it shows nothing at all.
    expect(tabFor('ws-2').querySelector('.todo-pill-shell')).toBeNull();
    expect(tabFor('ws-2').querySelector('[data-alert-ring-inset]')).toBeNull();
    expect(activateButton('ws-2').getAttribute('aria-label')).toBe('Workspace 2');

    // A TODO shows on the visible tab as on a hidden one.
    await act(async () => { setTerminalActivity('pane-d', { todo: true }); });
    expect(tabFor('ws-2').querySelector('.todo-pill-shell')).not.toBeNull();
    expect(tabFor('ws-2').querySelector('[data-alert-ring-inset]')).toBeNull();
    expect(activateButton('ws-2').getAttribute('aria-label')).toBe('Workspace 2, 2 needing attention');
  });

  /** Nothing else on screen appears or disappears with selection, so neither
   *  does the tab's TODO pill. */
  it('keeps the TODO pill through activating and leaving its Workspace', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a']);
    setTerminalActivity('pane-a', { todo: true });
    await render();
    const pill = tabFor(first).querySelector('.todo-pill-shell');
    expect(pill).not.toBeNull();

    await act(async () => { activateButton(first).click(); });
    expect(getActiveWorkspaceId()).toBe(first);
    expect(tabFor(first).querySelector('.todo-pill-shell')).toBe(pill);

    await act(async () => { activateButton('ws-2').click(); });
    expect(tabFor(first).querySelector('.todo-pill-shell')).toBe(pill);
  });

  /** The inset is the ring's only presence on a tab, so a Workspace whose
   *  members merely owe a TODO must not wear it. */
  it('leaves the alarm inset off a hidden Workspace with no ringing member', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a']);
    setTerminalActivity('pane-a', { todo: true });
    await render();

    expect(tabFor(first).querySelector('.todo-pill-shell')).not.toBeNull();
    expect(tabFor(first).querySelector('[data-alert-ring-inset]')).toBeNull();
  });

  /** The tab's summons is the Workspace's whole ringing interval, so losing the
   *  member that started it must not remount the inset and replay its burst. */
  it('keeps one burst while a Workspace stays ringing', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a', 'pane-b']);
    setTerminalActivity('pane-a', { status: 'ALERT_RINGING', episode: { id: 'older', startedAt: 1_000 } });
    setTerminalActivity('pane-b', { status: 'ALERT_RINGING', episode: { id: 'newer', startedAt: 2_000 } });
    await render();

    const inset = tabFor(first).querySelector('[data-alert-ring-inset]');
    expect(inset).not.toBeNull();

    // The older member is attended; the Workspace is still ringing through the
    // newer one, whose later start would otherwise become a fresh summons.
    await act(async () => { setTerminalActivity('pane-a', { status: 'NOTHING_TO_SHOW' }); });

    expect(tabFor(first).querySelector('[data-alert-ring-inset]')).toBe(inset);
  });

  /** The cache is the tab's memory of one ring, so a ring that ends while its
   *  Workspace is visible must not leave its start behind for the next one. */
  it('clocks the burst from the ring that began while the Workspace was visible', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a']);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);
    setTerminalActivity('pane-a', { status: 'ALERT_RINGING', episode: { id: 'first', startedAt: 1_000 } });
    await render();
    expect(tabFor(first).querySelector('[data-alert-ring-inset]')).not.toBeNull();

    // Attend that ring from its own tab, then let the member ring again while
    // the Workspace is the visible one and wears no inset.
    await act(async () => { activateButton(first).click(); });
    await act(async () => { setTerminalActivity('pane-a', { status: 'NOTHING_TO_SHOW' }); });
    await act(async () => {
      setTerminalActivity('pane-a', { status: 'ALERT_RINGING', episode: { id: 'second', startedAt: 9_000 } });
    });

    // Leaving reveals the summons: a burst 100ms old, not one clocked from the
    // ring that ended eight seconds ago and already past the animation's end.
    now.mockReturnValue(9_100);
    await act(async () => { activateButton('ws-2').click(); });
    const inset = tabFor(first).querySelector<HTMLElement>('[data-alert-ring-inset]')!;
    expect(inset.style.animationDelay).toBe('-100ms');
  });

  /** The visible tab wears no inset, so a ring attended while it was visible
   *  must not anchor the summons its tab shows once left. */
  it('clocks the burst on leaving from the rings still sounding', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a', 'pane-b']);
    const now = vi.spyOn(Date, 'now').mockReturnValue(2_000);
    await render();
    await act(async () => { activateButton(first).click(); });
    await act(async () => {
      setTerminalActivity('pane-a', { status: 'ALERT_RINGING', episode: { id: 'older', startedAt: 1_000 } });
      setTerminalActivity('pane-b', { status: 'ALERT_RINGING', episode: { id: 'newer', startedAt: 2_000 } });
    });
    await act(async () => { setTerminalActivity('pane-a', { status: 'NOTHING_TO_SHOW' }); });

    now.mockReturnValue(2_100);
    await act(async () => { activateButton('ws-2').click(); });
    const inset = tabFor(first).querySelector<HTMLElement>('[data-alert-ring-inset]')!;
    expect(inset.style.animationDelay).toBe('-100ms');
  });

  /** docs/specs/layout.md -> "Workspace tabs": the pill is its own click
   *  target, beside the tab's button rather than inside it. */
  it('selects the next TODO from its own pill, activating the Workspace and never renaming it', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a']);
    setTerminalActivity('pane-a', { todo: true });
    const handle = stubHandle(first, { selectNextTodo: vi.fn(() => true), enterCommandMode: vi.fn() });
    await render();

    const pill = todoPill(first)!;
    expect(pill.tagName).toBe('BUTTON');
    expect(activateButton(first).contains(pill)).toBe(false);
    expect(pill.getAttribute('aria-label')).toBe('Next TODO in Workspace 1');
    expect(activateButton(first).getAttribute('aria-label')).toBe('Workspace 1, 1 needing attention');

    await act(async () => { pill.click(); });
    expect(getActiveWorkspaceId()).toBe(first);
    expect(handle.selectNextTodo).toHaveBeenCalledTimes(1);
    expect(handle.enterCommandMode).not.toHaveBeenCalled();
    // On the visible tab it moves on to the next TODO, where the tab renames.
    await act(async () => { todoPill(first)!.click(); });
    expect(handle.selectNextTodo).toHaveBeenCalledTimes(2);
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
  });

  /** A TODO cleared between render and click leaves nothing to select. */
  it('activates in command mode from a pill with no TODO behind it, and never renames', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a']);
    setTerminalActivity('pane-a', { todo: true });
    const handle = stubHandle(first, { selectNextTodo: () => false, enterCommandMode: vi.fn() });
    await render();

    await act(async () => { todoPill(first)!.click(); });
    expect(getActiveWorkspaceId()).toBe(first);
    expect(handle.enterCommandMode).toHaveBeenCalledTimes(1);
    await act(async () => { todoPill(first)!.click(); });
    expect(handle.enterCommandMode).toHaveBeenCalledTimes(2);
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
  });

  it('ignores the click a drag from the pill ends with', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a']);
    setTerminalActivity('pane-a', { todo: true });
    const handle = stubHandle(first, { selectNextTodo: vi.fn(() => true) });
    await render();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 0, right: 100, width: 100, top: 0, bottom: 24, height: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    Object.defineProperty(tabFor(first), 'setPointerCapture', { configurable: true, value: () => {} });
    Object.defineProperty(tabFor(first), 'releasePointerCapture', { configurable: true, value: () => {} });

    await act(async () => { todoPill(first)!.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 50, clientY: 12 })); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', { clientX: 90, clientY: 12 })); });
    await act(async () => { window.dispatchEvent(pointer('pointerup', { clientX: 90, clientY: 12 })); });
    await act(async () => { todoPill(first)!.click(); });
    expect(handle.selectNextTodo).not.toHaveBeenCalled();
    expect(getActiveWorkspaceId()).toBe('ws-2');
    await act(async () => { todoPill(first)!.click(); });
    expect(handle.selectNextTodo).toHaveBeenCalledTimes(1);
  });

  it('renames the active tab on click, holding the chrome keyboard lease while the editor is open', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    expect(chromeKeyboardHeld()).toBe(false);

    await act(async () => {
      activateButton(first).click();
    });
    const input = container.querySelector<HTMLInputElement>(`[data-workspace-rename-for="${first}"]`)!;
    expect(chromeKeyboardHeld()).toBe(true);

    await act(async () => {
      typeInto(input, 'Deploys');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(tabNames()).toEqual(['Deploys']);
    expect(chromeKeyboardHeld()).toBe(false);
  });

  it('italicizes an auto-name until a rename changes it, and an empty rename hands it back', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    const nameSpan = () => tabFor(first).querySelector('span')!;
    const rename = async (value: string | null) => {
      await act(async () => { activateButton(first).click(); });
      const input = container.querySelector<HTMLInputElement>(`[data-workspace-rename-for="${first}"]`)!;
      await act(async () => {
        if (value !== null) typeInto(input, value);
        input.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
      });
    };
    expect(nameSpan().classList.contains('italic')).toBe(true);

    await rename(null); // opened and blurred: the editor submits, but nothing changed
    expect(nameSpan().classList.contains('italic')).toBe(true);

    await rename('Deploys');
    expect(tabNames()).toEqual(['Deploys']);
    expect(nameSpan().classList.contains('italic')).toBe(false);

    await rename('');
    expect(nameSpan().classList.contains('italic')).toBe(true);
  });

  it('never pins an auto-name that moved while the editor was open untouched', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    await act(async () => { activateButton(first).click(); });
    const input = container.querySelector<HTMLInputElement>(`[data-workspace-rename-for="${first}"]`)!;
    await act(async () => { setAutoWorkspaceName(first, 'dormouse @ main'); });
    await act(async () => { input.dispatchEvent(new FocusEvent('focusout', { bubbles: true })); });
    expect(getWorkspacesSnapshot().workspaces[0]).toMatchObject({ name: 'dormouse @ main', nameIsAuto: true });
  });

  it('shows the close button with one Workspace and closes an untouched one outright', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    expect(container.querySelector('[data-workspace-tab-close]')).not.toBeNull();

    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    const closed = vi.fn(async () => null);
    stubHandle('ws-2', { closeAll: closed });
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-workspace-tab-close="ws-2"]')!.click();
    });
    expect(closed).toHaveBeenCalledWith('prompt');
    expect(getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id)).toEqual([first]);
  });

  it('confirms before closing a Workspace holding work, and a refusal reveals it', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    stubHandle('ws-2', { hasTouchedSurfaces: () => true, closeAll: async () => 'notepad archive failed' });
    await render();
    // Close the INACTIVE one so the reveal is observable.
    await act(async () => { activateButton(first).click(); });

    await act(async () => {
      tabFor('ws-2').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true }));
    });
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(document.body.querySelector('#kill-confirm-title')).not.toBeNull();
    expect(chromeKeyboardHeld()).toBe(true);
    const char = document.body.querySelector('.text-xl')!.textContent!;

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    // Refused: the Workspace survives and is revealed so its prompt is visible.
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(chromeKeyboardHeld()).toBe(false);
  });

  it('reorders on a drag past the threshold, and Escape restores the original index', async () => {
    createWorkspace({ id: 'ws-2' });
    createWorkspace({ id: 'ws-3' });
    await render();
    const order = () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id);
    const first = order()[0];

    // jsdom lays nothing out; stub each tab's box so the center crossings are real.
    const boxes = new Map(order().map((id, index) => [id, { left: index * 100, width: 100 }]));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.dataset.workspaceTab;
      const box = id ? boxes.get(id) : undefined;
      const left = box?.left ?? 0;
      const width = box?.width ?? 300;
      return { left, right: left + width, width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    });

    await act(async () => { tabFor(first).dispatchEvent(pointer('pointerdown', { button: 0, clientX: 50, clientY: 12 })); });
    // Below the threshold: nothing moves.
    await act(async () => { window.dispatchEvent(pointer('pointermove', { clientX: 52, clientY: 12 })); });
    expect(order()[0]).toBe(first);
    // Past the second tab's center (150).
    await act(async () => { window.dispatchEvent(pointer('pointermove', { clientX: 160, clientY: 12 })); });
    expect(order()).toEqual(['ws-2', first, 'ws-3']);

    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(order()).toEqual([first, 'ws-2', 'ws-3']);
  });

  it('never captures the pointer before the drag activates, so a plain press still activates', async () => {
    createWorkspace({ id: 'ws-2' });
    await render();
    const first = getWorkspacesSnapshot().workspaces[0].id;
    // A captured pointer retargets the following `click` to the capture element,
    // which would swallow the activate button's own click on every tab press.
    const capture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: capture });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 0, right: 100, width: 100, top: 0, bottom: 24, height: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );

    await act(async () => { tabFor(first).dispatchEvent(pointer('pointerdown', { button: 0, clientX: 50, clientY: 12 })); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', { clientX: 52, clientY: 12 })); });
    expect(capture).not.toHaveBeenCalled();

    await act(async () => { window.dispatchEvent(pointer('pointermove', { clientX: 90, clientY: 12 })); });
    expect(capture).toHaveBeenCalled();
    await act(async () => { window.dispatchEvent(pointer('pointerup', { clientX: 90, clientY: 12 })); });
  });

  it('captures the pointer on the dragged tab, and activates on the click after the drag ends', async () => {
    createWorkspace({ id: 'ws-2' });
    await render();
    const first = getWorkspacesSnapshot().workspaces[0].id;
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(
      { left: 0, right: 100, width: 100, top: 0, bottom: 24, height: 24, x: 0, y: 0, toJSON: () => ({}) } as DOMRect,
    );
    // Spied on the ELEMENT, not the prototype: the capture has to land on the
    // tab, and React 19 hands the handler a native event whose `currentTarget`
    // is the root container.
    const tab = tabFor(first);
    const capture = vi.fn();
    Object.defineProperty(tab, 'setPointerCapture', { configurable: true, value: capture });
    Object.defineProperty(tab, 'releasePointerCapture', { configurable: true, value: () => {} });

    await act(async () => { tab.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 50, clientY: 12 })); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', { clientX: 90, clientY: 12 })); });
    expect(capture).toHaveBeenCalledTimes(1);
    await act(async () => { window.dispatchEvent(pointer('pointerup', { clientX: 90, clientY: 12 })); });

    // The click the release produces is the drag's tail and must not activate…
    await act(async () => { activateButton(first).click(); });
    expect(getActiveWorkspaceId()).toBe('ws-2');
    // …but the latch is one-shot, so the next click (a keyboard activation, a
    // later plain click) is a real activate again.
    await act(async () => { activateButton(first).click(); });
    expect(getActiveWorkspaceId()).toBe(first);
  });

  it('renders the rename editor and close flow the command-mode keys open', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await render();

    await act(async () => { requestWorkspaceRename(first); });
    expect(container.querySelector(`[data-workspace-rename-for="${first}"]`)).not.toBeNull();
    await act(async () => {
      container.querySelector<HTMLInputElement>(`[data-workspace-rename-for="${first}"]`)!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });

    const closed = vi.fn(async () => null);
    stubHandle('ws-2', { closeAll: closed });
    await act(async () => { requestWorkspaceClose('ws-2'); });
    expect(closed).toHaveBeenCalled();
  });

  it.each(['close', 'move'] as const)('defers the %s gate while another Workspace is being renamed', async (kind) => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    const proceed = vi.fn(async () => null);
    stubHandle('ws-2', { closeAll: proceed });
    await render();
    await act(async () => { requestWorkspaceRename(first); });
    await act(async () => {
      if (kind === 'close') setPendingWorkspaceClose({ id: 'ws-2', char: 'q' });
      else setPendingWorkspaceMove({ id: 'ws-2', char: 'q', iframeCount: 1, proceed });
    });
    const input = container.querySelector<HTMLInputElement>(`[data-workspace-rename-for="${first}"]`)!;
    expect(document.body.querySelector('#kill-confirm-title')).toBeNull();
    const typing = new KeyboardEvent('keydown', { key: 'q', bubbles: true, cancelable: true });
    await act(async () => { input.dispatchEvent(typing); });
    expect(typing.defaultPrevented).toBe(false);
    expect(proceed).not.toHaveBeenCalled();
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
    expect(document.body.querySelector('#kill-confirm-title')).not.toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true })); });
    expect(proceed).toHaveBeenCalledOnce();
  });

  it('keeps the move gate behind a close confirmation, and ignores modifiers and chords', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    stubHandle(first);
    const closed = vi.fn(async () => null);
    stubHandle('ws-2', { closeAll: closed });
    await render();
    const proceed = vi.fn();
    await act(async () => { setPendingWorkspaceMove({ id: first, char: 'k', iframeCount: 1, proceed }); });
    expect(document.body.querySelector('#kill-confirm-title')).not.toBeNull();

    // A bare modifier or a chord is never an answer, even on the gate's letter.
    await act(async () => {
      for (const key of ['Shift', 'Meta', 'Control', 'Alt']) {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      }
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }));
    });
    expect(proceed).not.toHaveBeenCalled();
    expect(getWorkspaceUiSnapshot().pendingMove).not.toBeNull();

    // A close raised over it shows its own letter; the same letter typed at it
    // closes and must not also move, however the two were minted.
    await act(async () => { setPendingWorkspaceClose({ id: 'ws-2', char: 'k' }); });
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(closed).toHaveBeenCalledTimes(1);
    expect(proceed).not.toHaveBeenCalled();
    expect(getWorkspaceUiSnapshot().pendingClose).toBeNull();
    expect(getWorkspaceUiSnapshot().pendingMove).not.toBeNull();

    // With the close resolved the gate is armed again, and its letter moves.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', bubbles: true }));
    });
    expect(proceed).toHaveBeenCalledTimes(1);
    expect(getWorkspaceUiSnapshot().pendingMove).toBeNull();
  });

  it('releases the rename lease when the tab being renamed is middle-clicked closed', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    stubHandle('ws-2', { closeAll: async () => null });
    await render();

    await act(async () => {
      activateButton('ws-2').click();
    });
    expect(chromeKeyboardHeld()).toBe(true);
    // Removing the focused input fires no `blur`, so neither submit nor cancel
    // runs: only the close verb can put `renamingId` back.
    await act(async () => {
      tabFor('ws-2').dispatchEvent(new MouseEvent('auxclick', { button: 1, bubbles: true, cancelable: true }));
    });
    await act(async () => { await Promise.resolve(); });
    expect(getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id)).toEqual([first]);
    expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
    expect(chromeKeyboardHeld()).toBe(false);
  });

  it('never starts a reorder from a press inside the open rename editor', async () => {
    createWorkspace({ id: 'ws-2' });
    createWorkspace({ id: 'ws-3' });
    await render();
    const order = () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id);
    const first = order()[0];
    const capture = vi.fn();
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: capture });
    Object.defineProperty(HTMLElement.prototype, 'releasePointerCapture', { configurable: true, value: () => {} });
    const boxes = new Map(order().map((id, index) => [id, { left: index * 100, width: 100 }]));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      const id = this.dataset.workspaceTab;
      const box = id ? boxes.get(id) : undefined;
      const left = box?.left ?? 0;
      const width = box?.width ?? 300;
      return { left, right: left + width, width, top: 0, bottom: 24, height: 24, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
    });

    await act(async () => { requestWorkspaceRename(first); });
    const input = container.querySelector<HTMLInputElement>(`[data-workspace-rename-for="${first}"]`)!;
    // A drag-select across the editor's text, well past the reorder threshold.
    await act(async () => { input.dispatchEvent(pointer('pointerdown', { button: 0, clientX: 50, clientY: 12 })); });
    await act(async () => { window.dispatchEvent(pointer('pointermove', { clientX: 160, clientY: 12 })); });
    await act(async () => { window.dispatchEvent(pointer('pointerup', { clientX: 160, clientY: 12 })); });
    expect(order()).toEqual([first, 'ws-2', 'ws-3']);
    expect(capture).not.toHaveBeenCalled();
    expect(getWorkspaceUiSnapshot().renamingId).toBe(first);
  });

  it('does not accept a pending kill during transfer and releases its keyboard lease on departure', async () => {
    createWorkspace({ id: 'ws-2' });
    const closeAll = vi.fn(async () => null);
    stubHandle('ws-2', { hasTouchedSurfaces: () => true, closeAll });
    await render();
    await act(async () => { setPendingWorkspaceClose({ id: 'ws-2', char: 'q' }); });
    expect(document.body.querySelector('#kill-confirm-title')?.textContent).toBe('Confirm kill workspace');
    expect(chromeKeyboardHeld()).toBe(true);
    setWorkspaceTransferPending('ws-2', true);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true })); });
    expect(closeAll).not.toHaveBeenCalled();
    expect(getWorkspaceUiSnapshot().pendingClose?.id).toBe('ws-2');
    // A failed transfer leaves this prompt usable; successful commit dismisses it.
    setWorkspaceTransferPending('ws-2', false);
    await act(async () => { dismissWorkspaceUi('ws-2'); });
    expect(document.body.querySelector('#kill-confirm-title')).toBeNull();
    expect(chromeKeyboardHeld()).toBe(false);
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', bubbles: true })); });
    expect(closeAll).not.toHaveBeenCalled();
  });

  it('keeps the close confirmation up through a bare Shift or Meta, as the pane kill does', async () => {
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    stubHandle('ws-2', { hasTouchedSurfaces: () => true, closeAll: async () => null });
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-workspace-tab-close="ws-2"]')!.click();
    });
    expect(document.body.querySelector('#kill-confirm-title')).not.toBeNull();

    for (const key of ['Shift', 'Meta']) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
      expect(document.body.querySelector('#kill-confirm-title')).not.toBeNull();
    }
    // Any other key still answers.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(document.body.querySelector('#kill-confirm-title')).toBeNull();
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);
  });
});


it('keeps a move refusal visible and releases the keyboard when dismissed', async () => {
  await render();
  await act(async () => setWorkspaceMoveError({ id: 'ws-1', reason: 'Wait for the Tool browser to connect before moving this Workspace' }));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain('Wait for the Tool browser');
  expect(chromeKeyboardHeld()).toBe(true);
  await act(async () => {
    (document.querySelector('[role="dialog"] button') as HTMLButtonElement).click();
  });
  expect(document.querySelector('[role="alert"]')).toBeNull();
  expect(getWorkspaceUiSnapshot().moveError).toBeNull();
  expect(chromeKeyboardHeld()).toBe(false);
});

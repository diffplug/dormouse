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
import {
  getWorkspaceUiSnapshot,
  resetWorkspaceUi,
  setPendingWorkspaceClose,
  setPendingWorkspaceMove,
} from '../lib/workspace-ui-store';
import {
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
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
    await act(async () => { activateButton(first).click(); });
    expect(getActiveWorkspaceId()).toBe(first);
  });

  it('shows indicators for a hidden Workspace only, counting them in its label', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    setWorkspaceSurfaces(first, ['pane-a', 'pane-b']);
    setWorkspaceSurfaces('ws-2', ['pane-c']);
    setTerminalActivity('pane-a', { status: 'ALERT_RINGING' });
    setTerminalActivity('pane-b', { todo: true });
    setTerminalActivity('pane-c', { status: 'ALERT_RINGING' });
    await render();

    expect(activateButton(first).getAttribute('aria-label')).toBe('Workspace 1, 2 needing attention');
    expect(tabFor(first).querySelector('.todo-pill-shell')).not.toBeNull();
    expect(tabFor(first).querySelector('svg')).not.toBeNull();
    // The visible Workspace shows its Surfaces, so its tab stays plain.
    expect(tabFor('ws-2').querySelector('.todo-pill-shell')).toBeNull();
  });

  it('renames on double-click, holding the chrome keyboard lease while the editor is open', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    expect(chromeKeyboardHeld()).toBe(false);

    await act(async () => {
      activateButton(first).dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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

  it('hides the close button with one Workspace and closes an untouched one outright', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    expect(container.querySelector('[data-workspace-tab-close]')).toBeNull();

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
      container.querySelector<HTMLButtonElement>('[data-workspace-tab-close="ws-2"]')!.click();
    });
    expect(container.querySelector('#kill-confirm-title')).not.toBeNull();
    expect(chromeKeyboardHeld()).toBe(true);
    const char = container.querySelector('.text-xl')!.textContent!;

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

  it('keeps the move gate behind a close confirmation, and ignores a bare Shift or Meta', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    stubHandle(first);
    const closed = vi.fn(async () => null);
    stubHandle('ws-2', { closeAll: closed });
    await render();
    const proceed = vi.fn();
    await act(async () => { setPendingWorkspaceMove({ id: first, char: 'k', iframeCount: 1, proceed }); });
    expect(container.querySelector('#kill-confirm-title')).not.toBeNull();

    // A bare modifier is the dual-tap detector's, never an answer to the gate.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Shift', bubbles: true }));
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Meta', bubbles: true }));
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
      activateButton('ws-2').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
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

  it('keeps the close confirmation up through a bare Shift or Meta, as the pane kill does', async () => {
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    stubHandle('ws-2', { hasTouchedSurfaces: () => true, closeAll: async () => null });
    await render();
    await act(async () => {
      container.querySelector<HTMLButtonElement>('[data-workspace-tab-close="ws-2"]')!.click();
    });
    expect(container.querySelector('#kill-confirm-title')).not.toBeNull();

    for (const key of ['Shift', 'Meta']) {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      });
      expect(container.querySelector('#kill-confirm-title')).not.toBeNull();
    }
    // Any other key still answers.
    await act(async () => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    });
    expect(container.querySelector('#kill-confirm-title')).toBeNull();
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);
  });
});

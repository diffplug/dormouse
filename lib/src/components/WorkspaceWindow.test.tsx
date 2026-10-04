/**
 * @vitest-environment jsdom
 *
 * The Window composition: one mounted Wall per Workspace, exactly one active,
 * and a switch that costs no Session anything (docs/specs/layout.md →
 * "Workspaces").
 */
import { StrictMode, act } from 'react';
import { flushSync } from 'react-dom';
import { type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS, WINDOW_CONTROL_METHODS } from 'dor/protocol';
import { moveSurface } from './wall/surface-move';
import { recordToolDirty, resetToolDirty } from '../lib/tool-dirty-store';
import { browserLeafMeta, toolLeafMeta } from './wall/lath-wall-engine';
import { leafTree } from '../lib/lath/model';
import { WorkspaceWindow } from './WorkspaceWindow';
import * as clipboard from '../lib/clipboard';
import { WorkspaceStrip } from './WorkspaceStrip';
import * as workspaceStore from '../lib/workspace-store';
import * as workspaceMotion from './workspace-motion';
import * as uiGeometry from '../lib/ui-geometry';
import { LATH_MOTION_MS } from '../lib/lath/animator';
import { closeWorkspaceWithSurfaces, requestWorkspaceClose } from './wall/workspace-lifecycle';
import * as terminalRegistry from '../lib/terminal-registry';
import * as helperTerminal from '../lib/helper-terminal';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { getActivitySnapshot, setTerminalActivity } from '../lib/terminal-registry';
import { createAlertEpisode } from '../lib/alert-episode';
import { getWallHandle, listWallHandles, resetWallHandles } from './wall/wall-handles';
import * as wallHandles from './wall/wall-handles';
import { resetWorkspaceBootPlans, setWorkspaceBootPlan } from './wall/workspace-boot-plans';
import { mountWallHarness, type WallHarness } from './wall/wall-test-utils';
import { getWorkspaceSurfacesSnapshot, resetWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { isWorkspaceTransferPending, previousWorkspaceSession, publishWorkspaceSession, resetWindowSessionAggregator, seedWindowSession, setWorkspaceTransferPending } from '../lib/window-session-aggregator';
import { getWorkspaceUiSnapshot, requestConfirmation, resetWorkspaceUi, settleConfirmation } from '../lib/workspace-ui-store';
import { resetTodoSpotlight } from '../lib/todo-spotlight';
import { _reopenRecordsForTesting, _resetReopenStackForTesting } from '../lib/reopen-stack';
import { reopenClosed } from './wall/reopen';
import { _resetPendingKillsForTesting, finalizePendingKill, getPendingKills, pendingKillKey, restorePendingKill } from '../lib/pending-kills';
import { _resetLabsSettingsForTesting, setDelayedKillSetting } from '../lib/labs-settings';
import {
  closeWorkspace,
  createWorkspace,
  getActiveWorkspaceId,
  getWorkspacesSnapshot,
  resetWorkspaces,
  setActiveWorkspace,
} from '../lib/workspace-store';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('./TerminalPane', () => ({
  TerminalPane: ({ id, isFocused }: { id: string; isFocused?: boolean }) => (
    <div data-testid="terminal-pane" data-session-id={id} data-focused={isFocused ? 'true' : 'false'} />
  ),
}));

let harness: WallHarness;
let container: HTMLDivElement;
let root: Root;
let fake: FakePtyAdapter;

beforeEach(() => {
  resetWallHandles();
  resetWorkspaces();
  resetWorkspaceSurfaces();
  resetWorkspaceUi();
  resetWindowSessionAggregator();
  resetWorkspaceBootPlans();
  resetTodoSpotlight();
  _resetReopenStackForTesting();
  fake = new FakePtyAdapter();
  setPlatform(fake);
  harness = mountWallHarness();
  ({ container, root } = harness);
});

afterEach(() => {
  resetToolDirty();
  harness.dispose();
  vi.clearAllMocks();
  vi.restoreAllMocks();
});

const flush = (): Promise<void> => harness.flush();
const flushFrame = (): Promise<void> => harness.flushFrame();

function walls(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('[data-workspace-wall]')];
}

function wallFor(workspaceId: string): HTMLElement {
  return container.querySelector<HTMLElement>(`[data-workspace-wall="${workspaceId}"]`)!;
}

/** Every mounted kill confirmation, whichever Wall rendered it. Modals render
 *  into `document.body`, outside every Wall. */
function killConfirms(): HTMLElement[] {
  return [...document.body.querySelectorAll<HTMLElement>('#kill-confirm-title')];
}

function leafIdsIn(workspaceId: string): string[] {
  return [...wallFor(workspaceId).querySelectorAll<HTMLElement>('[data-lath-leaf]')]
    .map((leaf) => leaf.getAttribute('data-lath-leaf')!);
}

async function render(node = <WorkspaceWindow initialPaneIds={['pane-a']} />): Promise<void> {
  await act(async () => root.render(node));
  await flush();
}

describe('WorkspaceWindow', () => {
  it('routes native file drops only to the active Workspace selected pane', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    const listeners = new Set<(paths: string[]) => void>();
    Object.assign(fake, {
      onFilesDropped: (handler: (paths: string[]) => void) => {
        listeners.add(handler);
        return () => { listeners.delete(handler); };
      },
    });
    const paste = vi.spyOn(clipboard, 'pasteFilePaths').mockImplementation(() => {});
    await render();
    expect(listeners.size).toBe(2);
    const drop = () => { for (const listener of listeners) listener(['C:/work/example.txt']); };
    await act(async () => { drop(); });
    expect(paste.mock.calls).toEqual([['pane-a', ['C:/work/example.txt']]]);
    paste.mockClear();
    await act(async () => { setActiveWorkspace('ws-2'); });
    const [secondPane] = leafIdsIn('ws-2');
    await act(async () => { drop(); });
    expect(paste.mock.calls).toEqual([[secondPane, ['C:/work/example.txt']]]);
    paste.mockClear();
    await act(async () => { setActiveWorkspace(first); });
    await act(async () => { drop(); });
    expect(paste.mock.calls).toEqual([['pane-a', ['C:/work/example.txt']]]);
  });

  it('clicking + enters the new terminal in passthrough and moves keyboard focus off the button', async () => {
    const first = getActiveWorkspaceId();
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const focus = vi.spyOn(terminalRegistry, 'focusSession');
    const button = container.querySelector<HTMLButtonElement>('[data-workspace-new]')!;
    button.focus();
    await act(async () => { button.click(); });
    await flush();
    await flushFrame();
    const created = getActiveWorkspaceId();
    expect(created).not.toBe(first);
    const [pane] = leafIdsIn(created);
    expect(wallFor(created).querySelector(`[data-session-id="${pane}"][data-focused="true"]`)).not.toBeNull();
    expect(focus).toHaveBeenCalledWith(pane, true);
  });

  it('keeps the outgoing Wall inert and visible beneath the incoming Wall until its fade ends', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    vi.spyOn(uiGeometry, 'motionIsInstant').mockReturnValue(false);
    for (const wall of walls()) {
      wall.getBoundingClientRect = () => ({ left: 0, top: 40, width: 1000, height: 600 }) as DOMRect;
    }
    for (const tab of container.querySelectorAll<HTMLElement>('[data-workspace-tab]')) {
      tab.getBoundingClientRect = () => ({ left: 0, top: 0, width: 100, height: 24 }) as DOMRect;
    }
    await act(async () => { setActiveWorkspace('ws-2'); });
    expect(wallFor(first).hasAttribute('inert')).toBe(true);
    expect(wallFor(first).classList.contains('invisible')).toBe(false);
    expect(wallFor('ws-2').hasAttribute('inert')).toBe(false);
    expect(wallFor('ws-2').classList.contains('z-10')).toBe(true);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, LATH_MOTION_MS + 30)); });
    expect(wallFor(first).classList.contains('invisible')).toBe(true);
    expect(wallFor('ws-2').classList.contains('invisible')).toBe(false);
  });

  it.each(['x', 'k'])('reveals and confirms a requested workspace close, then selects the next tab (%s)', async (killKey) => {
    // Every Workspace holds a touched shell, so every close confirms.
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    vi.spyOn(terminalRegistry, 'getTerminalInstance').mockReturnValue({} as ReturnType<typeof terminalRegistry.getTerminalInstance>);
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    createWorkspace({ id: 'ws-3', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const press = async (key: string) => {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      await flush();
    };
    const close = async () => {
      await press(killKey);
    };
    await press('ArrowUp');
    await press('ArrowRight');
    expect(getActiveWorkspaceId()).toBe(first);
    await press(killKey);
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(getWorkspaceUiSnapshot().confirmation?.id).toBe('ws-2');
    expect(leafIdsIn('ws-2')).toHaveLength(1);
    await press('Escape');
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(3);
    await close();
    await press(getWorkspaceUiSnapshot().confirmation!.char);
    await flush();
    expect(getActiveWorkspaceId()).toBe('ws-3');
    expect(getWorkspacesSnapshot().workspaces.map(workspace => workspace.id)).toEqual([first, 'ws-3']);
    await close();
    expect(getWorkspaceUiSnapshot().confirmation?.id).toBe('ws-3');
    await press(getWorkspaceUiSnapshot().confirmation!.char);
    await flush();
    expect(getActiveWorkspaceId()).toBe(first);
    await close();
    expect(getWorkspaceUiSnapshot().confirmation?.id).toBe(first);
    await press(getWorkspaceUiSnapshot().confirmation!.char);
    const replacement = getActiveWorkspaceId();
    expect(replacement).not.toBe(first);
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
    expect(leafIdsIn(replacement)).toHaveLength(1);
    expect(getWallHandle(first)).toBeNull();
    expect(leafIdsIn(replacement)).not.toContain('pane-a');
    await close();
    expect(getWorkspaceUiSnapshot().confirmation?.id).toBe(replacement);
  });

  it('returns from the successor tab to pane navigation after a Workspace close', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    await act(async () => { await closeWorkspaceWithSurfaces(first); });
    await flush();
    expect(getActiveWorkspaceId()).toBe('ws-2');
    for (const key of ['ArrowDown', 'Enter']) {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      await flush();
    }
    expect(wallFor('ws-2').querySelector('[data-focused="true"]')).not.toBeNull();
  });

  it('keeps the closing tab and its Surfaces until the workspace collapse finishes', async () => {
    createWorkspace({ id: 'ws-2' });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    let finish!: () => void;
    vi.spyOn(workspaceMotion, 'collapseWorkspace').mockImplementation(() => new Promise<void>(resolve => { finish = resolve; }));
    let closing!: Promise<string | null>;
    await act(async () => { closing = closeWorkspaceWithSurfaces('ws-2'); });
    expect(container.querySelector('[data-workspace-tab="ws-2"]')).not.toBeNull();
    expect(getWallHandle('ws-2')!.surfaceIds()).toEqual(['pane-a']);
    await act(async () => { finish(); expect(await closing).toBeNull(); });
    await flush();
    expect(container.querySelector('[data-workspace-tab="ws-2"]')).toBeNull();
    expect(getWallHandle('ws-2')).toBeNull();
  });

  it('clicking an inactive tab activates it in command mode even if it was left in passthrough', async () => {
    const first = getActiveWorkspaceId();
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    await act(async () => { getWallHandle(first)!.enterSelectedPane(); });
    await flush();
    expect(wallFor(first).querySelector('[data-focused="true"]')).not.toBeNull();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();

    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-workspace-tab="${first}"] button`)!.click();
    });
    await flush();
    expect(getActiveWorkspaceId()).toBe(first);
    expect(wallFor(first).querySelector('[data-focused="true"]')).toBeNull();
    expect(container.querySelector('[data-workspace-rename-for]')).toBeNull();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '|', bubbles: true })); });
    await flush();
    expect(leafIdsIn(first)).toHaveLength(2);
  });

  it.each(['command', 'passthrough'] as const)('clicking the active tab renames without leaving %s mode', async mode => {
    const first = getActiveWorkspaceId();
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    if (mode === 'passthrough') {
      await act(async () => { getWallHandle(first)!.enterSelectedPane(); });
      await flush();
    }
    const focused = () => wallFor(first).querySelector('[data-focused="true"]') !== null;
    expect(focused()).toBe(mode === 'passthrough');
    await act(async () => {
      container.querySelector<HTMLButtonElement>(`[data-workspace-tab="${first}"] button`)!.click();
    });
    const input = container.querySelector<HTMLInputElement>('[data-workspace-rename-for]')!;
    expect(document.activeElement).toBe(input);
    expect(focused()).toBe(mode === 'passthrough');
    await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(container.querySelector('[data-workspace-rename-for]')).toBeNull();
    expect(focused()).toBe(mode === 'passthrough');
  });

  it('comma edits the highlighted Workspace without switching, then returns to navigation', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', name: 'Build', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const press = async (key: string, target: EventTarget = window) => {
      await act(async () => { target.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      await flush();
    };
    await press('ArrowUp');
    await press('ArrowRight');
    await press(',');
    const input = container.querySelector<HTMLInputElement>('[data-workspace-rename-for="ws-2"]')!;
    expect(document.activeElement).toBe(input);
    expect(input.value).toBe('Build');
    expect(getActiveWorkspaceId()).toBe(first);
    await act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Deploy');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await press('Enter', input);
    expect(getWorkspacesSnapshot().workspaces.find(workspace => workspace.id === 'ws-2')?.name).toBe('Deploy');
    expect(container.querySelector('[data-workspace-rename-for]')).toBeNull();
    expect(getActiveWorkspaceId()).toBe(first);
    await press('Enter');
    expect(getActiveWorkspaceId()).toBe('ws-2');
  });

  it('keeps removed Workspace commands inert on a selected tab', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    await act(async () => { getWallHandle(first)!.selectWorkspaceTab(); });
    for (const key of ['n', 'p', '$', '&']) {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      await flush();
      expect(getActiveWorkspaceId()).toBe(first);
      expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);
      expect(getWorkspaceUiSnapshot().renamingId).toBeNull();
      expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
      expect(wallFor(first).querySelector('[data-focused="true"]')).toBeNull();
    }
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true })); });
    await flush();
    expect(getActiveWorkspaceId()).toBe('ws-2');
  });

  it('navigates Workspace tabs with arrows and Enter, entering the active tab or creating from +', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const press = async (key: string, location = 0) => {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, location, bubbles: true, cancelable: true })); });
      await flush();
    };
    await press('ArrowUp');
    await press('ArrowRight');
    expect(getActiveWorkspaceId()).toBe(first);
    await press('Enter');
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(wallFor('ws-2').querySelector('[data-focused="true"]')).toBeNull();
    await press('Enter');
    expect(wallFor('ws-2').querySelector('[data-focused="true"]')).not.toBeNull();
    expect(container.querySelector('[data-workspace-rename-for]')).toBeNull();

    await press('Shift', 1);
    await press('Shift', 2);
    await press('ArrowUp');
    await press('ArrowLeft');
    await press('ArrowDown');
    expect(getActiveWorkspaceId()).toBe('ws-2');
    await press('Enter');
    expect(wallFor('ws-2').querySelector('[data-focused="true"]')).not.toBeNull();

    await press('Shift', 1);
    await press('Shift', 2);
    await press('ArrowUp');
    await press('ArrowRight'); // +
    await press('Enter');
    const created = getActiveWorkspaceId();
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(3);
    expect(created).not.toBe('ws-2');
    expect(wallFor(created).querySelector('[data-focused="true"]')).not.toBeNull();
  });

  /** docs/specs/layout.md -> "Workspace tabs": the pill is a click on the TODO
   *  member, so keys go there next — from the Workspace the click left too. */
  it('enters a Workspace\'s TODO pane from its tab pill in passthrough, keyboard focus included, hidden or visible', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPlans={{
      [first]: { initialPaneIds: ['pane-a'] },
      'ws-2': { initialPaneIds: ['pane-x', 'pane-y'] },
    }} /></>);
    // Left in passthrough, so the switch hands keyboard focus over.
    await act(async () => { getWallHandle(first)!.enterSelectedPane(); });
    await flush();
    await act(async () => { setTerminalActivity('pane-y', { todo: true }); });
    // Stand-ins for the panes' xterms, focusable as a browser allows: never
    // inside an inert (hidden) Workspace.
    const releases: Array<() => void> = [];
    const keysFor = (id: string) => {
      const keys = document.createElement('textarea');
      wallFor('ws-2').append(keys);
      releases.push(terminalRegistry.registerSurfaceFocusHandle(id, {
        focus: () => { if (!keys.closest('[inert]')) keys.focus(); },
        blur: () => keys.blur(),
      }), () => keys.remove());
      return keys;
    };
    const keysY = keysFor('pane-y');
    const keysX = keysFor('pane-x');
    const acknowledge = vi.spyOn(fake, 'alertAcknowledge');
    const clearing = [vi.spyOn(fake, 'alertDismiss'), vi.spyOn(fake, 'alertClearTodo'), vi.spyOn(fake, 'alertToggleTodo')];
    const clickPill = async () => {
      const pill = container.querySelector<HTMLButtonElement>('[data-workspace-tab="ws-2"] [data-workspace-tab-todo]')!;
      // Chromium focuses a pressed button; the click must not leave it there.
      pill.focus();
      await act(async () => { pill.click(); });
      await flush();
      await flushFrame();
    };
    try {
      await clickPill();
      expect(getActiveWorkspaceId()).toBe('ws-2');
      expect(wallFor('ws-2').querySelector('[data-session-id="pane-y"][data-focused="true"]')).not.toBeNull();
      expect(document.activeElement).toBe(keysY);
      // As a click on the pane: acknowledged without input, so a ring would
      // leave its TODO, and no verb clears the TODO it has.
      expect(acknowledge.mock.calls).toEqual([['pane-y']]);
      for (const verb of clearing) expect(verb).not.toHaveBeenCalled();
      expect(getActivitySnapshot().get('pane-y')?.todo).toBe(true);

      // The visible tab's pill moves the keys on to the next TODO the same way.
      await act(async () => { setTerminalActivity('pane-x', { todo: true }); });
      await clickPill();
      expect(wallFor('ws-2').querySelector('[data-session-id="pane-x"][data-focused="true"]')).not.toBeNull();
      expect(document.activeElement).toBe(keysX);
      expect(acknowledge.mock.calls).toEqual([['pane-y'], ['pane-x']]);
    } finally {
      for (const release of releases) release();
      terminalRegistry.clearTerminalActivity();
    }
  });

  /** docs/specs/alert.md -> Pane Header: where a tab pill's click lands, that
   *  Surface's header pill says so — a Door's once the click reattached it. */
  it('spotlights the header pill a tab TODO pill enters, reattaching a Door, replaying a repeat, never clearing a TODO', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPlans={{
      [first]: { initialPaneIds: ['pane-a'] },
      'ws-2': { initialPaneIds: ['pane-x', 'pane-y'], initialDoors: [{ id: 'door-z', title: 'Z' }] },
    }} /></>);
    await act(async () => { setTerminalActivity('pane-y', { todo: true }); });
    const acknowledge = vi.spyOn(fake, 'alertAcknowledge');
    const clearing = [
      vi.spyOn(fake, 'alertDismiss'), vi.spyOn(fake, 'alertClearTodo'), vi.spyOn(fake, 'alertToggleTodo'),
      vi.spyOn(terminalRegistry, 'dismissSessionAlert'), vi.spyOn(terminalRegistry, 'clearSessionTodo'),
      vi.spyOn(terminalRegistry, 'toggleSessionTodo'),
    ];
    const pill = () => container.querySelector<HTMLButtonElement>('[data-workspace-tab="ws-2"] [data-workspace-tab-todo]')!;
    const spotlightOn = (id: string) => wallFor('ws-2').querySelector(`[data-session-todo-for="${id}"] [data-todo-spotlight]`);
    const inPassthrough = (id: string) => wallFor('ws-2').querySelector(`[data-session-id="${id}"][data-focused="true"]`) !== null;
    const clickPill = async () => {
      await act(async () => { pill().click(); });
      await flush();
    };
    try {
      // The hover asks the hidden Workspace's Wall where the click will land.
      await act(async () => { pill().dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body })); });
      expect(pill().title).toMatch(/^Next TODO: \S/);
      expect(spotlightOn('pane-y')).toBeNull();

      await clickPill();
      expect(getActiveWorkspaceId()).toBe('ws-2');
      expect(inPassthrough('pane-y')).toBe(true);
      const landed = spotlightOn('pane-y');
      expect(landed).not.toBeNull();
      // Its only TODO again, from passthrough on it: the same pill, replayed.
      await clickPill();
      expect(inPassthrough('pane-y')).toBe(true);
      expect(spotlightOn('pane-y')).not.toBeNull();
      expect(spotlightOn('pane-y')).not.toBe(landed);

      // Next after pane-y, the Door: reattached into passthrough, where its
      // header's pill takes the pulse; pane-y's ends.
      await act(async () => { setTerminalActivity('door-z', { todo: true }); });
      await clickPill();
      expect(wallFor('ws-2').querySelector('[data-door-id="door-z"]')).toBeNull();
      expect(inPassthrough('door-z')).toBe(true);
      expect(spotlightOn('door-z')).not.toBeNull();
      expect(spotlightOn('pane-y')).toBeNull();

      expect(acknowledge.mock.calls).toEqual([['pane-y'], ['pane-y'], ['door-z']]);
      for (const verb of clearing) expect(verb).not.toHaveBeenCalled();
      expect(['pane-y', 'door-z'].map((id) => getActivitySnapshot().get(id)?.todo)).toEqual([true, true]);
    } finally {
      terminalRegistry.clearTerminalActivity();
    }
  });

  it('answers a key from one Wall even when that key activates another', async () => {
    // A browser runs a microtask checkpoint between listeners, which is where
    // React commits the newly active Wall. Synchronous dispatch skips it, so each
    // keydown listener commits pending renders before the next one runs.
    const committing = new WeakMap<EventListenerOrEventListenerObject, EventListener>();
    const add = window.addEventListener.bind(window);
    const remove = window.removeEventListener.bind(window);
    vi.spyOn(window, 'addEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) => {
      if (type !== 'keydown' || typeof listener !== 'function') return add(type, listener, options);
      const commit: EventListener = (e) => { listener(e); flushSync(() => {}); };
      committing.set(listener, commit);
      return add(type, commit, options);
    }) as typeof window.addEventListener);
    vi.spyOn(window, 'removeEventListener').mockImplementation(((type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) =>
      remove(type, committing.get(listener) ?? listener, options)) as typeof window.removeEventListener);

    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const activate = vi.spyOn(workspaceStore, 'activateWorkspaceAt');
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: '2', bubbles: true, cancelable: true })); });
    await flush();
    // The newly activated Wall must not dispatch the same key a second time.
    expect(activate).toHaveBeenCalledOnce();
    expect(getActiveWorkspaceId()).toBe('ws-2');
  });

  it('returns to a live pane when the highlighted Workspace disappears', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    for (const key of ['ArrowUp', 'ArrowRight']) {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true })); });
    }
    await act(async () => { closeWorkspace('ws-2'); });
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); });
    await flush();
    expect(getActiveWorkspaceId()).toBe(first);
    expect(wallFor(first).querySelector('[data-session-id="pane-a"][data-focused="true"]')).not.toBeNull();
  });

  it('mounts one Wall per Workspace with exactly one active, and seeds only the boot Workspace', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    expect(leafIdsIn(first)).toEqual(['pane-a']);

    const second = await act(async () => createWorkspace({ id: 'ws-2' }).id);
    await flush();

    expect(walls().map((wall) => wall.dataset.workspaceActive)).toEqual(['false', 'true']);
    expect(getActiveWorkspaceId()).toBe(second);
    // A Workspace created later gets no boot record: Lath's fresh branch spawns
    // exactly one pane, and the boot Workspace is untouched.
    expect(leafIdsIn(first)).toEqual(['pane-a']);
    expect(leafIdsIn(second)).toHaveLength(1);
    expect(leafIdsIn(second)[0]).not.toBe('pane-a');
    // Both Walls are in the same grid cell, so the box never changes on a switch.
    expect(walls().every((wall) => wall.className.includes('col-start-1 row-start-1'))).toBe(true);
    expect(wallFor(first).className).toContain('invisible');
    expect(wallFor(first).hasAttribute('inert')).toBe(true);
    expect(wallFor(second).className).not.toContain('invisible');
    expect(wallFor(second).hasAttribute('inert')).toBe(false);
  });

  it('mounts a returning Workspace from the record it brought, not the one it first booted with', async () => {
    // A Workspace can leave this Window and come back — dragged out and dragged
    // in again (docs/specs/standalone.md → "Transfer"). Its first mount latched
    // a plan; re-using that one would put a fresh default pane over the Sessions
    // that just arrived, and the running work would be gone.
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();

    const moving = await act(async () => createWorkspace({ id: 'ws-travelling' }).id);
    await flush();
    const bootPane = leafIdsIn(moving)[0]!;

    // It leaves.
    await act(async () => { closeWorkspace(moving); });
    await flush();
    expect(walls().map((wall) => wall.dataset.workspaceWall)).toEqual([first]);

    // …and comes back, carrying its own record.
    setWorkspaceBootPlan(moving, { initialPaneIds: ['pane-arrived'] });
    await act(async () => { createWorkspace({ id: moving }); });
    await flush();

    expect(leafIdsIn(moving)).toEqual(['pane-arrived']);
    expect(leafIdsIn(moving)).not.toContain(bootPane);
  });

  it('registers one handle per Workspace, publishing membership, even under StrictMode', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render(<StrictMode><WorkspaceWindow initialPaneIds={['pane-a']} /></StrictMode>);
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();

    expect(listWallHandles().map((handle) => handle.workspaceId).sort()).toEqual([first, 'ws-2'].sort());
    expect(getWallHandle(first)!.surfaceIds()).toEqual(['pane-a']);
    expect(getWorkspaceSurfacesSnapshot().get(first)).toEqual(['pane-a']);
    expect(getWorkspaceSurfacesSnapshot().get('ws-2')).toHaveLength(1);
  });

  it('costs a Session nothing to switch: the leaf is never remounted and no ring replays', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    setTerminalActivity('pane-a', { status: 'ALERT_RINGING', episode: createAlertEpisode() });
    const episodeBefore = getActivitySnapshot().get('pane-a')!.episode;
    expect(episodeBefore?.id).toBeTruthy();
    const leafBefore = wallFor(first).querySelector('[data-lath-leaf="pane-a"]');
    const paneBefore = wallFor(first).querySelector('[data-session-id="pane-a"]');

    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();
    await act(async () => { setActiveWorkspace(first); });
    await flush();

    // A switch flips a prop; it never unmounts a leaf, so nothing calls
    // mountElement / resumeTerminal / restoreTerminal and the delivery episode
    // cannot restart (docs/specs/glossary.md → "Invariants" I8).
    expect(wallFor(first).querySelector('[data-lath-leaf="pane-a"]')).toBe(leafBefore);
    expect(wallFor(first).querySelector('[data-session-id="pane-a"]')).toBe(paneBefore);
    expect(getActivitySnapshot().get('pane-a')!.episode?.id).toBe(episodeBefore?.id);
  });

  it('gives host New Terminal and the dialog hosts to the visible Workspace only', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render(
      <WorkspaceWindow initialPaneIds={['pane-a']} dialogHost={<div data-testid="dialog-host" />} />,
    );
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();

    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:new-terminal', { detail: {} }));
    });
    await flush();

    expect(leafIdsIn(first)).toEqual(['pane-a']);
    expect(leafIdsIn('ws-2')).toHaveLength(2);
    // One dialog host for the Window, rendered by the visible Workspace's Wall
    // so it sits in that Wall's DialogKeyboardContext.
    const hosts = container.querySelectorAll('[data-testid="dialog-host"]');
    expect(hosts).toHaveLength(1);
    expect(wallFor('ws-2').contains(hosts[0])).toBe(true);
  });

  it('closeAll empties a Workspace without the auto-spawn refilling it', async () => {
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();

    const handle = getWallHandle('ws-2')!;
    expect(handle.surfaceIds()).toHaveLength(1);
    await act(async () => { expect(await handle.closeAll()).toBeNull(); });
    await flush();
    expect(handle.surfaceIds()).toEqual([]);
    expect(leafIdsIn('ws-2')).toEqual([]);
  });

  it('keeps a dead PTY\'s retained cwd and alert across a restored Workspace\'s first save', async () => {
    // The first save after a restore has nothing of its own to compare against:
    // it must read the record boot seeded, or a pane whose PTY did not survive
    // the relaunch (its probe answers null) loses the cwd and alert the last
    // run persisted for it — exactly the values a cold restore spawns it from.
    const first = getWorkspacesSnapshot().workspaces[0].id;
    seedWindowSession({
      version: 1,
      workspaces: [{
        id: first,
        name: 'One',
        session: {
          version: 3,
          doors: [],
          panes: [{ id: 'pane-a', title: 'Pane A', cwd: '/retained', untouched: false, alert: { status: 'NOTHING_TO_SHOW', todo: true } }],
        },
      }],
      activeWorkspaceId: first,
    });
    await render();

    await act(async () => { await getWallHandle(first)!.flushPersistence(); });

    const saved = previousWorkspaceSession(first)!.panes.find((pane) => pane.id === 'pane-a');
    expect(saved).toMatchObject({ cwd: '/retained', alert: { status: 'NOTHING_TO_SHOW', todo: true } });
  });

  it('leaves no persisted record behind a closed Workspace', async () => {
    // The closing Wall's unmount used to publish one last time, putting the
    // Workspace it had just forgotten back into the next Window blob — with its
    // Surfaces gone — for the next launch to restore as an empty Workspace.
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();
    // Its Wall has saved at least once, as one does the moment it auto-spawns.
    publishWorkspaceSession('ws-2', { version: 3, panes: [] });
    expect(previousWorkspaceSession('ws-2')).not.toBeNull();

    await act(async () => { await closeWorkspaceWithSurfaces('ws-2'); });
    await flush();

    expect(getWorkspacesSnapshot().workspaces.map((ws) => ws.id)).not.toContain('ws-2');
    expect(previousWorkspaceSession('ws-2')).toBeNull();
  });

  it('serializes two closes started together, so the survivor keeps its Surfaces', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();

    // Both close verbs run: the second is refused rather than emptying a Wall
    // the store will then refuse to remove.
    let refusals: Array<string | null> = [];
    await act(async () => {
      refusals = await Promise.all([
        closeWorkspaceWithSurfaces(first),
        closeWorkspaceWithSurfaces('ws-2'),
      ]);
    });
    await flush();

    expect(refusals.filter((refusal) => refusal === null)).toHaveLength(1);
    const survivors = getWorkspacesSnapshot().workspaces;
    expect(survivors).toHaveLength(1);
    expect(getWallHandle(survivors[0].id)!.surfaceIds()).toHaveLength(1);
    expect(leafIdsIn(survivors[0].id)).toHaveLength(1);
  });

  it.each([
    SURFACE_CONTROL_METHODS.split,
    SURFACE_CONTROL_METHODS.tool,
    SURFACE_CONTROL_METHODS.browser,
  ])('refuses %s while its Workspace is closing', async (method) => {
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();
    const handle = getWallHandle('ws-2')!;
    const [paneId] = handle.surfaceIds();
    const respond = vi.fn();

    await act(async () => {
      // Dispatched INSIDE the walk: `dor split` from a member pane still routes
      // here, and a Surface born behind the walk would ride the unmount out.
      const closing = handle.closeAll();
      handle.handleDorControl({
        requestId: 'r1',
        method,
        surfaceId: paneId,
        // `session` names the browser the two browser verbs would bind.
        params: { direction: 'right', session: 'gui-closing' },
        respond,
      });
      expect(await closing).toBeNull();
    });
    await flush();

    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'this workspace is closing' });
    expect(handle.surfaceIds()).toEqual([]);
    expect(leafIdsIn('ws-2')).toEqual([]);
  });

  it('refuses a Playwright surface.browser whose host answer lands after the close began', async () => {
    // The Playwright arm asks the host for the viewer before it creates
    // anything, so the guard above is not the last word.
    const status = Promise.withResolvers<{ ok: boolean; stream: number; headed: boolean }>();
    const browser = vi.fn(() => status.promise);
    Object.assign(fake, { browserProviders: ['agent-browser', 'playwright'], browser });
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();
    const handle = getWallHandle('ws-2')!;
    const [paneId] = handle.surfaceIds();
    const respond = vi.fn();

    act(() => {
      void handle.handleDorControl({
        requestId: 'late-pw',
        method: SURFACE_CONTROL_METHODS.browser,
        surfaceId: paneId,
        params: { provider: 'playwright', session: 'late', cwd: '/repo' },
        respond,
      });
    });
    await flush();
    expect(browser).toHaveBeenCalledWith(expect.objectContaining({ provider: 'playwright', op: 'attach', binding: expect.objectContaining({ session: 'late' }) }));
    await act(async () => { expect(await handle.closeAll()).toBeNull(); });
    await act(async () => status.resolve({ ok: true, stream: 4321, headed: false }));
    await flush();

    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'this workspace is closing' });
    expect(handle.surfaceIds()).toEqual([]);
  });

  it('names each Workspace its own agent-browser session for the same --key', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2', name: 'build' }); });
    await flush();

    /** `dor agent-browser --key default` asking whichever Workspace will hold the browser
     *  what that key's session is called. */
    const sessionFor = (workspaceId: string): string => {
      const respond = vi.fn();
      getWallHandle(workspaceId)!.handleDorControl({
        requestId: 'r1',
        method: SURFACE_CONTROL_METHODS.resolveBrowser,
        params: { provider: 'agent-browser', key: 'default' },
        respond,
      });
      expect(respond).toHaveBeenCalledWith({ ok: true, result: { binding: { session: expect.any(String) }, fresh: false } });
      return respond.mock.calls[0][0].result.binding.session;
    };

    // One `--key default` per Workspace, not one shared browser: the session
    // name carries the Workspace's stable id.
    expect(sessionFor(first)).toBe(`dormouse.${first}.default`);
    expect(sessionFor('ws-2')).toBe('dormouse.ws-2.default');
  });

  it('keeps a hidden Workspace out of the window keyboard: its kill confirm outlives an Escape next door', async () => {
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();

    const press = async (key: string) => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
      await flush();
    };

    // Stage the confirmation in ws-2 while it is the visible Workspace.
    await press('x');
    expect(killConfirms()).toHaveLength(1);

    // Hidden: the overlay is unmounted, so its Escape trap hears nothing…
    await act(async () => { setActiveWorkspace(first); });
    await flush();
    expect(killConfirms()).toHaveLength(0);
    await press('Escape');

    // …and the staged confirmation is still there on the way back.
    await act(async () => { setActiveWorkspace('ws-2'); });
    await flush();
    expect(killConfirms()).toHaveLength(1);
  });

  it('binds the command-mode Workspace keys through the active Wall only', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    const press = async (key: string) => {
      await act(async () => {
        window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true }));
      });
      await flush();
    };

    // A bare `c` never creates a Workspace; that is the strip's `+`.
    await press('c');
    const ids = () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id);
    expect(ids()).toHaveLength(1);
    await act(async () => { createWorkspace(); });
    await flush();
    const second = ids()[1];
    expect(getActiveWorkspaceId()).toBe(second);

    for (const key of ['n', 'p', '$', '&']) await press(key);
    expect(getActiveWorkspaceId()).toBe(second);
    await press('1');
    expect(getActiveWorkspaceId()).toBe(first);
    // Out of range does nothing rather than wrapping.
    await press('9');
    expect(getActiveWorkspaceId()).toBe(first);

    await press('2');
    expect(getActiveWorkspaceId()).toBe(second);
  });

  it('closes a fresh Workspace without confirming', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    const handle = getWallHandle(first)!;
    expect(handle.needsCloseConfirmation()).toBe(false);
  });
});


it.each([
  ['switched', true],
  ['transferring', false],
  ['closed', false],
] as const)('respects Workspace lifecycle after takeover acceptance: %s', async (change, launches) => {
  const controller = new AbortController();
  const typed: string[] = [];
  const first = getActiveWorkspaceId();
  try {
    await render();
    act(() => fake.spawnPty('pane-a'));
    fake.setInputHandler('pane-a', data => typed.push(data));
    terminalRegistry.seedTerminalManualCwd('pane-a', '/repo');
    terminalRegistry.applyTerminalSemanticEvents('pane-a', [
      { type: 'commandLine', commandLine: 'dor tool -- pnpm dev' },
      { type: 'commandStart', source: 'osc633_boundaries' },
    ]);
    const respond = vi.fn();
    await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
      method: SURFACE_CONTROL_METHODS.tool, surfaceId: 'pane-a',
      params: { command: ['pnpm', 'dev'], cwd: '/repo' }, signal: controller.signal, respond,
    } })));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ result: expect.objectContaining({ status: 'takeover' }) }));
    await act(async () => {
      if (change === 'transferring') setWorkspaceTransferPending(first, true);
      else createWorkspace({ id: 'ws-2' });
    });
    if (change === 'closed') {
      await act(async () => {
        expect(await closeWorkspaceWithSurfaces(first, 'silent')).toBeNull();
      });
    }
    await act(async () => {
      terminalRegistry.applyTerminalSemanticEvents('pane-a', [{ type: 'promptStart' }]);
    });
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 150)); });
    expect(typed).toEqual(launches ? ['pnpm dev\r'] : []);
    if (change === 'closed') {
      expect(getWallHandle(first)).toBeNull();
      expect(getWorkspacesSnapshot().workspaces.map(workspace => workspace.id)).toEqual(['ws-2']);
    } else {
      expect(leafIdsIn(first)).toEqual(['pane-a']);
      const prepared = await getWallHandle(first)!.prepareWorkspaceTransfer();
      expect(prepared.payload.workspace.session.panes[0]?.surfaceType === 'tool').toBe(launches);
    }
    if (change !== 'transferring') expect(getActiveWorkspaceId()).toBe('ws-2');
  } finally {
    controller.abort();
    setWorkspaceTransferPending(first, false);
    fake.clearInputHandler('pane-a');
    act(() => terminalRegistry.removeTerminalPaneState('pane-a'));
  }
});

it('routes Tools to the requested Workspace and never launches after lookup races closure', async () => {
  const lookup = { status: 'untrusted' as const, projectRoot: '/repo', path: '/repo/dormouse.yml', name: 'storybook', run: 'pnpm storybook', upstreamUrl: null, warnings: [] };
  const gate = Promise.withResolvers<typeof lookup>();
  const toolControl = vi.fn().mockResolvedValueOnce(lookup).mockImplementationOnce(() => gate.promise);
  Object.assign(fake, { toolControl });
  await render();
  const first = getActiveWorkspaceId();
  await act(async () => { createWorkspace({ id: 'ws-2' }); });
  await flush();
  const respond = vi.fn();
  await act(async () => window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
    requestId: 'tool-route', surfaceId: 'pane-a', method: SURFACE_CONTROL_METHODS.tool,
    params: { workspace: 'workspace:2', name: 'storybook', cwd: '/repo' }, respond,
  } })));
  await flush();
  expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: true, result: expect.objectContaining({ status: 'pending' }) }));
  expect(leafIdsIn(first)).toEqual(['pane-a']);
  expect(leafIdsIn('ws-2')).toHaveLength(2);
  expect(getActiveWorkspaceId()).toBe('ws-2');

  const handle = getWallHandle('ws-2')!;
  const late = vi.fn();
  act(() => { void handle.handleDorControl({ requestId: 'late-tool', method: SURFACE_CONTROL_METHODS.tool,
    params: { name: 'storybook', cwd: '/repo' }, respond: late }); });
  await flush();
  await act(async () => { await handle.closeAll(); });
  await act(async () => gate.resolve(lookup));
  await flush();
  expect(late).toHaveBeenCalledWith({ ok: false, error: 'this workspace is closing' });
  expect(handle.surfaceIds()).toEqual([]);
});


describe('Surface moves between Workspaces', () => {
  const request = (destination: { workspace: string } | { new: true }, focus = false) => ({ destination, focus, dangerouslyDestroyIframePageState: false });
  async function twoWalls(sourcePanes = ['pane-a', 'pane-b']) {
    const source = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', name: 'new', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPlans={{ [source]: { initialPaneIds: sourcePanes }, 'ws-2': { initialPaneIds: ['pane-x'] } }} /></>);
    return source;
  }

  it('preserves Session identity, TODO and retained cwd, retires the source ref, and recomputes both unions', async () => {
    const source = await twoWalls();
    publishWorkspaceSession(source, { version: 3, panes: [{ id: 'pane-a', title: 'exited', cwd: '/retained' }, { id: 'pane-b', title: 'other' }] });
    await act(async () => setTerminalActivity('pane-a', { todo: true }));
    const kill = vi.spyOn(fake, 'killPty');
    const acknowledge = vi.spyOn(fake, 'alertAcknowledge');
    let result;
    await act(async () => { result = await moveSurface('pane-a', request({ workspace: 'new' })); });
    expect(result).toMatchObject({ surfaceId: 'pane-a', surfaceRef: 'surface:2', workspaceId: 'ws-2' });
    expect(getWallHandle(source)!.surfaceIds()).toEqual(['pane-b']);
    expect(getWallHandle('ws-2')!.surfaceIds()).toEqual(['pane-x', 'pane-a']);
    expect(getActiveWorkspaceId()).toBe(source);
    expect(kill).not.toHaveBeenCalled();
    expect(acknowledge).not.toHaveBeenCalled();
    expect(getActivitySnapshot().get('pane-a')?.todo).toBe(true);
    expect(getWorkspaceSurfacesSnapshot().get(source)).toEqual(['pane-b']);
    expect(getWorkspaceSurfacesSnapshot().get('ws-2')).toContain('pane-a');
    expect(previousWorkspaceSession(source)?.surfaceRefs).not.toHaveProperty('pane-a');
    expect(previousWorkspaceSession('ws-2')?.panes.find(p => p.id === 'pane-a')?.cwd).toBe('/retained');
    const respond = vi.fn();
    await act(async () => getWallHandle(source)!.handleDorControl({ requestId: 'retired', method: SURFACE_CONTROL_METHODS.read, params: { surface: 'surface:1' }, respond }));
    expect(respond).toHaveBeenCalledWith(expect.objectContaining({ ok: false }));
  });

  it('fences a save collected during adoption before the retained cwd migrates', async () => {
    const source = await twoWalls();
    publishWorkspaceSession(source, { version: 3, panes: [{ id: 'pane-a', title: 'exited', cwd: '/retained' }, { id: 'pane-b', title: 'other' }] });
    const target = getWallHandle('ws-2')!;
    const finish = target.finishSurfaceMove;
    let duringCommit!: Promise<void>;
    vi.spyOn(target, 'finishSurfaceMove').mockImplementation(() => {
      finish();
      duringCommit = target.flushPersistence({ probeCwd: false });
    });
    await act(async () => {
      await moveSurface('pane-a', request({ workspace: 'workspace:2' }));
      await duringCommit;
    });
    expect(previousWorkspaceSession('ws-2')?.panes.find(pane => pane.id === 'pane-a')?.cwd).toBe('/retained');
  });

  it('routes a moved dor caller to its destination: short refs can name another pane and ensure can duplicate work left behind', async () => {
    const source = await twoWalls();
    terminalRegistry.seedTerminalManualCwd('pane-b', '/repo');
    terminalRegistry.applyTerminalSemanticEvents('pane-b', [{ type: 'commandLine', commandLine: 'pnpm dev' }, { type: 'commandStart', source: 'osc633_boundaries' }]);
    await act(async () => { await moveSurface('pane-a', request({ workspace: 'workspace:2' })); });
    const ask = async (method: string, params: Record<string, unknown>) => {
      let answer: unknown;
      await act(async () => { answer = await new Promise(resolve => {
        window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
          requestId: 'moved-caller', surfaceId: 'pane-a', method, params, respond: resolve,
        } }));
        if (method === SURFACE_CONTROL_METHODS.ensure) {
          const created = getWallHandle('ws-2')!.surfaceIds().find(id => id !== 'pane-x' && id !== 'pane-a')!;
          terminalRegistry.applyTerminalSemanticEvents(created, [{ type: 'promptStart' }]);
        }
      }); });
      return answer;
    };
    expect(await ask(SURFACE_CONTROL_METHODS.read, { surface: 'surface:1' })).toMatchObject({ ok: true, result: { surfaceId: 'pane-x' } });
    expect(await ask(SURFACE_CONTROL_METHODS.read, { surface: 'surface:pane-b' })).toMatchObject({ ok: true, result: { surfaceId: 'pane-b' } });
    expect(await ask(SURFACE_CONTROL_METHODS.ensure, { command: ['pnpm', 'dev'], cwd: '/repo', minimized: false, restart: false })).toMatchObject({ ok: true, result: { status: 'created' } });
    expect(getWallHandle(source)!.surfaceIds()).toEqual(['pane-b']);
    expect(getWallHandle('ws-2')!.surfaceIds()).toHaveLength(3);
  });

  it('removes an emptied source and activates the destination in command mode for a neutral CLI move', async () => {
    const source = await twoWalls(['pane-a']);
    await act(async () => { await moveSurface('pane-a', request({ workspace: 'workspace:2' })); });
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual(['ws-2']);
    expect(getWallHandle(source)).toBeNull();
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(wallFor('ws-2').querySelector('[data-focused="true"]')).toBeNull();
  });

  it('creates a receiving Workspace with only the moved Surface and follows a GUI move into passthrough', async () => {
    const source = await twoWalls();
    let result: Awaited<ReturnType<typeof moveSurface>> = null;
    await act(async () => { result = await moveSurface('pane-a', request({ new: true }), true); });
    const target = getActiveWorkspaceId();
    expect(target).not.toBe(source);
    expect(getWallHandle(target)!.surfaceIds()).toEqual(['pane-a']);
    expect(wallFor(target).querySelector('[data-session-id="pane-a"][data-focused="true"]')).not.toBeNull();
    expect(result).toMatchObject({ surfaceRef: 'surface:1' });
    await act(async () => { await expect(moveSurface('pane-a', request({ new: true }))).rejects.toThrow('only Surface'); });
  });

  it('rolls back layout, ownership, references and allocator when destination adoption fails', async () => {
    const source = await twoWalls();
    const target = getWallHandle('ws-2')!;
    const adoption = vi.spyOn(target, 'adoptSurfaceMove').mockImplementation(() => { throw new Error('placement failed'); });
    await act(async () => { await expect(moveSurface('pane-a', request({ workspace: 'workspace:2' }))).rejects.toThrow('placement failed'); });
    expect(getWallHandle(source)!.surfaceIds()).toEqual(['pane-a', 'pane-b']);
    expect(target.surfaceIds()).toEqual(['pane-x']);
    expect(getWallHandle(source)!.serializeNow().surfaceRefs).toEqual({ 'pane-a': 'surface:1', 'pane-b': 'surface:2' });
    adoption.mockRestore();
  });

  it('refuses a move to a new Workspace whose Wall is not registered synchronously, and discards it', async () => {
    const source = await twoWalls();
    const real = wallHandles.getWallHandle;
    vi.spyOn(wallHandles, 'getWallHandle').mockImplementation(id => id === source || id === 'ws-2' ? real(id) : null);
    await act(async () => { await expect(moveSurface('pane-a', request({ new: true }))).rejects.toThrow('The new Workspace did not mount'); });
    vi.mocked(wallHandles.getWallHandle).mockRestore();
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([source, 'ws-2']);
    expect(getWallHandle(source)!.surfaceIds()).toEqual(['pane-a', 'pane-b']);
    expect(getActiveWorkspaceId()).toBe(source);
  });

  it('fences a pre-departure save collected during new Workspace mounting', async () => {
    const source = await twoWalls();
    let finishProbe!: (cwd: string | null) => void;
    let staleSave!: Promise<void>;
    vi.spyOn(fake, 'getCwd').mockImplementation(id => id === 'pane-a' ? new Promise(resolve => { finishProbe = resolve; }) : Promise.resolve('/other'));
    const unsubscribe = workspaceStore.subscribeToWorkspaces(() => {
      if (!staleSave && getWorkspacesSnapshot().workspaces.length === 3) staleSave = getWallHandle(source)!.flushPersistence();
    });
    let moved!: NonNullable<Awaited<ReturnType<typeof moveSurface>>>;
    await act(async () => { moved = (await moveSurface('pane-a', request({ new: true })))!; });
    unsubscribe();
    expect(finishProbe).toBeTypeOf('function');
    await act(async () => { finishProbe('/stale'); await staleSave; });
    expect(previousWorkspaceSession(source)?.panes.map(p => p.id)).toEqual(['pane-b']);
    expect(previousWorkspaceSession(moved.workspaceId)?.panes.map(p => p.id)).toEqual(['pane-a']);
  });

  it('keeps committed membership if destination focus fails after the empty source closes', async () => {
    const source = await twoWalls(['pane-a']);
    vi.spyOn(workspaceStore, 'setActiveWorkspace').mockImplementation(() => { throw new Error('focus failed'); });
    await act(async () => { await expect(moveSurface('pane-a', request({ workspace: 'workspace:2' }, true))).rejects.toThrow('focus failed'); });
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual(['ws-2']);
    expect(getWallHandle(source)).toBeNull();
    expect(getWallHandle('ws-2')!.ownsSurface('pane-a')).toBe(true);
    expect(previousWorkspaceSession(source)).toBeNull();
    expect(previousWorkspaceSession('ws-2')?.panes.map(p => p.id)).toContain('pane-a');
  });

  it('refuses same-Workspace moves before inspecting dirty Tool state', async () => {
    await twoWalls();
    await act(async () => { await expect(moveSurface('pane-a', request({ workspace: 'workspace:1' }))).rejects.toThrow('already in that Workspace'); });
  });

  it('shows alternate-screen move notices over the pane without writing into the program display', async () => {
    await twoWalls();
    const write = vi.fn();
    const terminal = vi.spyOn(terminalRegistry, 'getTerminalInstance').mockReturnValue({ buffer: { active: { type: 'alternate' } }, write } as unknown as ReturnType<typeof terminalRegistry.getTerminalInstance>);
    await act(async () => { await moveSurface('pane-a', request({ workspace: 'workspace:2' }, true)); });
    expect(write).not.toHaveBeenCalled();
    expect(container.querySelector('.shell-spawn-notice')?.textContent).toContain('Cached surface:N refs now resolve here');
    terminal.mockRestore();
  });

  it('moves a Door into a pane without terminating it and keeps a nonempty source', async () => {
    const source = await twoWalls();
    // The same minimize proposal used by a header button.
    const minimize = wallFor(source).querySelector<HTMLButtonElement>('[aria-label="Minimize"]');
    expect(minimize).not.toBeNull();
    await act(async () => minimize!.click());
    const minimized = getWallHandle(source)!.surfaceIds().find(id => !leafIdsIn(source).includes(id))!;
    expect(minimized).toBeTruthy();
    await act(async () => { await moveSurface(minimized, request({ workspace: 'workspace:2' })); });
    expect(leafIdsIn('ws-2')).toContain(minimized);
    expect(getWallHandle(source)!.surfaceIds()).not.toContain(minimized);
  });

  it.each(['browser', 'tool'] as const)('requires consent for %s iframes; cancellation preserves membership and dirty Tools cannot bypass refusal', async kind => {
    const source = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    if (kind === 'tool') terminalRegistry.applyTerminalSemanticEvents('frame', [{ type: 'commandLine', commandLine: 'file-editor' }, { type: 'commandStart', source: 'osc633_boundaries' }]);
    const meta = kind === 'browser' ? browserLeafMeta('Frame', { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:3000/saved' })
      : toolLeafMeta('Editor', { surfaceType: 'tool', command: 'file-editor', toolArgv: ['dor', 'builtin:file', '/tmp/file.txt'], renderMode: 'iframe', toolRender: 'iframe', url: 'http://localhost:3000/saved' });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPlans={{ [source]: { restoredLathLayout: { version: 1, tree: leafTree('frame'), leafMeta: { frame: meta } } }, 'ws-2': { initialPaneIds: ['pane-x'] } }} /></>);
    await act(async () => { await expect(moveSurface('frame', request({ workspace: 'workspace:2' }))).rejects.toThrow('dangerously-destroy'); });
    let pending!: Promise<Awaited<ReturnType<typeof moveSurface>>>;
    await act(async () => { pending = moveSurface('frame', request({ workspace: 'workspace:2' }), true); });
    expect(getWorkspaceUiSnapshot().confirmation).not.toBeNull();
    expect(document.body.textContent).toContain('saved URL');
    expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
    await act(async () => { settleConfirmation(getWorkspaceUiSnapshot().confirmation!, false); await pending; });
    expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
    if (kind === 'tool') {
      recordToolDirty('frame', true);
      await act(async () => { await expect(moveSurface('frame', { ...request({ workspace: 'workspace:2' }), dangerouslyDestroyIframePageState: true })).rejects.toThrow('edits'); });
      recordToolDirty('frame', false);
      await act(async () => { pending = moveSurface('frame', request({ workspace: 'workspace:2' }), true); });
      recordToolDirty('frame', true);
      await act(async () => { settleConfirmation(getWorkspaceUiSnapshot().confirmation!, true); await expect(pending).rejects.toThrow('edits'); });
      expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
      recordToolDirty('frame', false);
    }
    await act(async () => { pending = moveSurface('frame', request({ workspace: 'workspace:2' }), true); });
    await act(async () => { settleConfirmation(getWorkspaceUiSnapshot().confirmation!, true); await pending; });
    expect(getWallHandle('ws-2')!.ownsSurface('frame')).toBe(true);
  });

  /** A source holding only a plain iframe, beside two terminal Workspaces. */
  async function iframeWalls() {
    const source = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    createWorkspace({ id: 'ws-3', activate: false });
    const meta = browserLeafMeta('Frame', { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:3000/saved' });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPlans={{ [source]: { restoredLathLayout: { version: 1, tree: leafTree('frame'), leafMeta: { frame: meta } } }, 'ws-2': { initialPaneIds: ['pane-x'] }, 'ws-3': { initialPaneIds: ['pane-y'] } }} /></>);
    return source;
  }

  it('answers a pending confirmation no when a Surface move starts', async () => {
    await twoWalls();
    const answer = vi.fn();
    requestConfirmation({ id: 'ws-2', char: 'q', answer });
    await act(async () => { await moveSurface('pane-a', request({ workspace: 'workspace:2' })); });
    expect(answer).toHaveBeenCalledExactlyOnceWith(false);
    expect(getWallHandle('ws-2')!.ownsSurface('pane-a')).toBe(true);
  });

  it('answers a pending iframe consent no when a Workspace close is requested', async () => {
    const source = await iframeWalls();
    let pending!: Promise<Awaited<ReturnType<typeof moveSurface>>>;
    await act(async () => { pending = moveSurface('frame', request({ workspace: 'workspace:2' }), true); });
    expect(getWorkspaceUiSnapshot().confirmation?.title).toBe('Move iframe?');
    await act(async () => { requestWorkspaceClose('ws-2'); expect(await pending).toBeNull(); });
    expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
    expect(isWorkspaceTransferPending(source)).toBe(false);
    // The released destination is no longer guarded, so its untouched close runs.
    await act(async () => { await vi.waitFor(() => expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([source, 'ws-3'])); });
    expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
  });

  it('does not let an older close awaiting its Wall replace a newer iframe consent', async () => {
    const source = await iframeWalls();
    vi.spyOn(getWallHandle('ws-2')!, 'needsCloseConfirmation').mockReturnValue(true);
    let pending!: Promise<Awaited<ReturnType<typeof moveSurface>>>;
    await act(async () => {
      requestWorkspaceClose('ws-2');
      pending = moveSurface('frame', request({ workspace: workspaceStore.workspaceRefFor('ws-3') }), true);
    });
    expect(getWorkspaceUiSnapshot().confirmation?.title).toBe('Move iframe?');
    expect(getWorkspaceUiSnapshot().confirmation?.id).toBe(source);
    await act(async () => { settleConfirmation(getWorkspaceUiSnapshot().confirmation!, false); await pending; });
  });

  it('lets a second GUI iframe move supersede the first one’s consent and complete', async () => {
    const source = await iframeWalls();
    let first!: Promise<Awaited<ReturnType<typeof moveSurface>>>;
    let second!: Promise<Awaited<ReturnType<typeof moveSurface>>>;
    await act(async () => { first = moveSurface('frame', request({ workspace: 'workspace:2' }), true); });
    const firstConsent = getWorkspaceUiSnapshot().confirmation;
    await act(async () => { second = moveSurface('frame', request({ workspace: workspaceStore.workspaceRefFor('ws-3') }), true); });
    await act(async () => { expect(await first).toBeNull(); });
    // The superseded move's cleanup leaves the second one's guards in place.
    expect(isWorkspaceTransferPending(source)).toBe(true);
    expect(isWorkspaceTransferPending('ws-3')).toBe(true);
    expect(getWorkspaceUiSnapshot().confirmation).not.toBe(firstConsent);
    await act(async () => { settleConfirmation(getWorkspaceUiSnapshot().confirmation!, true); await second; });
    expect(getWallHandle('ws-3')!.ownsSurface('frame')).toBe(true);
    expect(getWallHandle('ws-2')!.ownsSurface('frame')).toBe(false);
    expect([source, 'ws-2', 'ws-3'].some(isWorkspaceTransferPending)).toBe(false);
  });

  it('rechecks a Tool that becomes dirty in the final preparation microtask', async () => {
    const source = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    terminalRegistry.applyTerminalSemanticEvents('editor', [{ type: 'commandLine', commandLine: 'file-editor' }, { type: 'commandStart', source: 'osc633_boundaries' }]);
    const meta = toolLeafMeta('Editor', { surfaceType: 'tool', command: 'file-editor', toolArgv: ['dor', 'builtin:file', '/tmp/file.txt'], renderMode: 'iframe', toolRender: 'iframe', url: 'http://localhost:3000/saved' });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPlans={{ [source]: { restoredLathLayout: { version: 1, tree: leafTree('editor'), leafMeta: { editor: meta } } }, 'ws-2': { initialPaneIds: ['pane-x'] } }} /></>);
    const handle = getWallHandle(source)!;
    const prepare = handle.prepareSurfaceMove;
    let calls = 0;
    vi.spyOn(handle, 'prepareSurfaceMove').mockImplementation(id => {
      const prepared = prepare(id);
      if (++calls === 2) queueMicrotask(() => recordToolDirty(id, true));
      return prepared;
    });
    await act(async () => { await expect(moveSurface('editor', { ...request({ workspace: 'workspace:2' }), dangerouslyDestroyIframePageState: true })).rejects.toThrow('edits'); });
    expect(handle.ownsSurface('editor')).toBe(true);
    expect(getWallHandle('ws-2')!.ownsSurface('editor')).toBe(false);
  });

  it('asks again when a Surface becomes an iframe during the persistence flush: dor refuses, the GUI prompts', async () => {
    const source = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    const meta = browserLeafMeta('Frame', { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:3000/saved' });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPlans={{ [source]: { restoredLathLayout: { version: 1, tree: leafTree('frame'), leafMeta: { frame: meta } } }, 'ws-2': { initialPaneIds: ['pane-x'] } }} /></>);
    // Only the first preparation, before the flush, sees no iframe yet.
    const notYetServing = () => {
      const handle = getWallHandle(source)!;
      const real = handle.prepareSurfaceMove;
      return vi.spyOn(handle, 'prepareSurfaceMove').mockImplementationOnce(id => ({ ...real(id), iframe: false }));
    };
    const cli = notYetServing();
    await act(async () => { await expect(moveSurface('frame', request({ workspace: 'workspace:2' }))).rejects.toThrow('dangerously-destroy'); });
    expect(cli.mock.calls.length).toBeGreaterThan(1);
    expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
    cli.mockRestore();
    notYetServing();
    let pending!: Promise<Awaited<ReturnType<typeof moveSurface>>>;
    await act(async () => { pending = moveSurface('frame', request({ workspace: 'workspace:2' }), true); });
    expect(getWorkspaceUiSnapshot().confirmation).not.toBeNull();
    expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
    await act(async () => { settleConfirmation(getWorkspaceUiSnapshot().confirmation!, false); expect(await pending).toBeNull(); });
    expect(getWallHandle(source)!.ownsSurface('frame')).toBe(true);
  });
});

describe('Reopen a closed Workspace', () => {
  const WEB = { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173/docs' };

  /** ws-2 holds one iframe browser: every member reopenable. */
  async function renderWithBrowserWorkspace(): Promise<string> {
    const first = getActiveWorkspaceId();
    setWorkspaceBootPlan('ws-2', { restoredLathLayout: {
      version: 1, tree: leafTree('web'), leafMeta: { web: browserLeafMeta('docs', WEB) },
    } });
    createWorkspace({ id: 'ws-2', name: 'docs', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    return first;
  }

  it('closes a Workspace holding only reopenable members unasked and reopens it whole, at its slot', async () => {
    const first = await renderWithBrowserWorkspace();
    createWorkspace({ id: 'ws-3', activate: false });
    await flush();
    await act(async () => { requestWorkspaceClose('ws-2'); });
    await flush();
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([first, 'ws-3']);
    expect(_reopenRecordsForTesting().map(record => record.kind)).toEqual(['workspace']);

    await act(async () => { reopenClosed({ gesture: true }); });
    await flush();
    const ids = getWorkspacesSnapshot().workspaces.map(ws => ws.id);
    const reopened = ids[1];
    expect(ids).toEqual([first, reopened, 'ws-3']);
    expect(reopened).not.toBe('ws-2');
    expect(getActiveWorkspaceId()).toBe(reopened);
    expect(getWorkspacesSnapshot().workspaces[1].name).toBe('docs');
    const [leaf] = leafIdsIn(reopened);
    expect(leaf).not.toBe('web');
    expect(getWallHandle(reopened)!.serializeNow().lathLayout).toMatchObject({ leafMeta: { [leaf]: { params: WEB } } });
  });

  it('answers dor reopen with the Workspace it reopened, leaving the active one active', async () => {
    const first = await renderWithBrowserWorkspace();
    await act(async () => { expect(await closeWorkspaceWithSurfaces('ws-2', 'silent')).toBeNull(); });
    await flush();
    let response: { ok: boolean; result?: { kind: string; workspaceId: string; workspaceRef: string } } | undefined;
    await act(async () => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: WINDOW_CONTROL_METHODS.reopen, params: {}, respond: (r: typeof response) => { response = r; },
      } }));
    });
    await flush();
    const reopened = getWorkspacesSnapshot().workspaces[1].id;
    expect(response).toEqual({ ok: true, result: { status: 'reopened', kind: 'workspace', workspaceId: reopened, workspaceRef: workspaceStore.workspaceRefFor(reopened) } });
    expect(getActiveWorkspaceId()).toBe(first);
  });

  it('leaves no record when a member made the close confirm', async () => {
    await renderWithBrowserWorkspace();
    vi.spyOn(getWallHandle('ws-2')!, 'needsCloseConfirmation').mockReturnValue(true);
    await act(async () => { expect(await closeWorkspaceWithSurfaces('ws-2', 'silent')).toBeNull(); });
    await flush();
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).not.toContain('ws-2');
    expect(_reopenRecordsForTesting()).toHaveLength(0);
  });
});

it('never moves a Wall\'s DOM when the strip reorders, which would reload its iframes', async () => {
  const first = getActiveWorkspaceId();
  createWorkspace({ id: 'ws-2', activate: false });
  createWorkspace({ id: 'ws-3', activate: false });
  await render();
  const before = walls();
  await act(async () => { workspaceStore.moveWorkspace('ws-3', 0); });
  await flush();
  expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual(['ws-3', first, 'ws-2']);
  expect(walls()).toEqual(before);
});

describe('Labs: a Workspace close that would ask, kept pending', () => {
  beforeEach(() => {
    Object.assign(fake, { offersLabs: true });
    setDelayedKillSetting(true);
    // Every shell has been typed into, so every Workspace close would ask.
    vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
    vi.spyOn(terminalRegistry, 'getTerminalInstance').mockReturnValue({} as ReturnType<typeof terminalRegistry.getTerminalInstance>);
  });
  afterEach(() => {
    _resetPendingKillsForTesting();
    _resetLabsSettingsForTesting();
  });

  async function pendSecond(): Promise<string> {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    createWorkspace({ id: 'ws-3', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    await act(async () => { requestWorkspaceClose('ws-2'); });
    await flush();
    return first;
  }

  it('leaves the strip at once, asking nothing, with its Wall still mounted', async () => {
    const first = await pendSecond();
    expect(getWorkspaceUiSnapshot().confirmation).toBeNull();
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([first, 'ws-3']);
    expect(wallFor('ws-2')).not.toBeNull();
    expect(getPendingKills().map(kill => [kill.kind, kill.id, kill.title])).toEqual([['workspace', 'ws-2', 'build']]);
    const listed = await new Promise<{ ok: boolean; error?: string }>(resolve => {
      act(() => { window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.list, params: { workspace: 'build' }, respond: resolve,
      } })); });
    });
    expect(listed).toEqual({ ok: false, error: "workspace 'build' is a pending kill" });
  });

  it('refuses dor commands into its hidden Wall, by a member\'s id or from a member', async () => {
    await pendSecond();
    const [leaf] = leafIdsIn('ws-2');
    const send = (detail: Record<string, unknown>) => new Promise<{ ok: boolean; error?: string }>(resolve => {
      act(() => { window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: { ...detail, respond: resolve } })); });
    });
    expect(await send({ method: SURFACE_CONTROL_METHODS.read, params: { surface: leaf } }))
      .toEqual({ ok: false, error: `workspace '${workspaceStore.workspaceRefFor('ws-2')}' is a pending kill` });
    expect(await send({ method: SURFACE_CONTROL_METHODS.split, surfaceId: leaf, params: {} }))
      .toEqual({ ok: false, error: `workspace '${workspaceStore.workspaceRefFor('ws-2')}' is a pending kill` });
    expect(leafIdsIn('ws-2')).toEqual([leaf]);
  });

  it('restores to its slot with the same Wall and Surfaces', async () => {
    const first = await pendSecond();
    const leaves = leafIdsIn('ws-2');
    await act(async () => { restorePendingKill(pendingKillKey('workspace', 'ws-2')); });
    await flush();
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([first, 'ws-2', 'ws-3']);
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(leafIdsIn('ws-2')).toEqual(leaves);
  });

  it('brings a pending Workspace back first when restoring a Surface pended inside it', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', name: 'build' });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const [leaf] = leafIdsIn('ws-2');
    await act(async () => {
      wallFor('ws-2').querySelector<HTMLButtonElement>(`[data-lath-leaf="${leaf}"] button[aria-label="Kill"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await flush();
    await act(async () => { requestWorkspaceClose('ws-2'); });
    await flush();
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([first]);
    await act(async () => { restorePendingKill(pendingKillKey('surface', leaf)); });
    await flush();
    expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([first, 'ws-2']);
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(leafIdsIn('ws-2')).toContain(leaf);
  });

  it('asks as before, pending nothing, when a member\'s helper runs a command', async () => {
    vi.spyOn(helperTerminal, 'getHelper').mockImplementation(id => id.startsWith('pane') ? { id: 'helper', parentId: id, command: '', status: 'running' } : undefined);
    vi.spyOn(helperTerminal, 'helperHasWork').mockResolvedValue(true);
    createWorkspace({ id: 'ws-2', name: 'build', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    await act(async () => { requestWorkspaceClose('ws-2'); });
    await flush();
    expect(getPendingKills()).toEqual([]);
    expect(getWorkspaceUiSnapshot().confirmation?.id).toBe('ws-2');
  });

  it('takes back the unused replacement for a pended last Workspace when it returns', async () => {
    const only = getActiveWorkspaceId();
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    // The replacement's own shell reads as untouched: nobody has used it.
    vi.spyOn(terminalRegistry, 'isUntouched').mockImplementation(id => !leafIdsIn(only).includes(id));
    await act(async () => { requestWorkspaceClose(only); });
    await flush();
    const [replacement] = getWorkspacesSnapshot().workspaces.map(ws => ws.id);
    expect(replacement).not.toBe(only);
    await act(async () => { restorePendingKill(pendingKillKey('workspace', only)); });
    await act(async () => { await vi.waitFor(() => expect(getWorkspacesSnapshot().workspaces.map(ws => ws.id)).toEqual([only])); });
  });

  it('closes through every member Surface when finalized, then lets its Wall go', async () => {
    const dispose = vi.spyOn(terminalRegistry, 'disposeSession');
    await pendSecond();
    const [leaf] = leafIdsIn('ws-2');
    await act(async () => { finalizePendingKill(pendingKillKey('workspace', 'ws-2')); });
    await act(async () => { await vi.waitFor(() => expect(wallFor('ws-2')).toBeNull()); });
    expect(dispose).toHaveBeenCalledWith(leaf);
    expect(getPendingKills()).toEqual([]);
  });
});

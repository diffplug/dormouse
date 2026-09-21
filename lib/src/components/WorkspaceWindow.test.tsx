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
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { WorkspaceWindow } from './WorkspaceWindow';
import { WorkspaceStrip } from './WorkspaceStrip';
import * as workspaceMotion from './workspace-motion';
import * as uiGeometry from '../lib/ui-geometry';
import { LATH_MOTION_MS } from '../lib/lath/animator';
import { closeWorkspaceWithSurfaces } from './wall/workspace-lifecycle';
import * as terminalRegistry from '../lib/terminal-registry';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { clearAllNotepads, addPlainNote } from '../lib/notepad/notepad-store';
import { __resetArchiveServiceForTests } from '../lib/notepad/archive-service';
import { getActivitySnapshot, setTerminalActivity } from '../lib/terminal-registry';
import { getWallHandle, listWallHandles, resetWallHandles } from './wall/wall-handles';
import { resetWorkspaceBootPlans, setWorkspaceBootPlan } from './wall/workspace-boot-plans';
import { mountWallHarness, type WallHarness } from './wall/wall-test-utils';
import { getWorkspaceSurfacesSnapshot, resetWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { previousWorkspaceSession, publishWorkspaceSession, resetWindowSessionAggregator, seedWindowSession, setWorkspaceTransferPending } from '../lib/window-session-aggregator';
import { getWorkspaceUiSnapshot, resetWorkspaceUi } from '../lib/workspace-ui-store';
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
  __resetArchiveServiceForTests();
  clearAllNotepads();
  resetWallHandles();
  resetWorkspaces();
  resetWorkspaceSurfaces();
  resetWorkspaceUi();
  resetWindowSessionAggregator();
  resetWorkspaceBootPlans();
  fake = new FakePtyAdapter();
  setPlatform(fake);
  harness = mountWallHarness();
  ({ container, root } = harness);
});

afterEach(() => {
  harness.dispose();
  vi.clearAllMocks();
  vi.restoreAllMocks();
  __resetArchiveServiceForTests();
  clearAllNotepads();
});

const flush = (): Promise<void> => harness.flush();

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

  it('reveals and confirms x on a highlighted workspace, then selects the next tab for repeated deletion', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    createWorkspace({ id: 'ws-3', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const press = async (key: string) => {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); });
      await flush();
    };
    await press('ArrowUp');
    await press('ArrowRight');
    expect(getActiveWorkspaceId()).toBe(first);
    await press('x');
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(getWorkspaceUiSnapshot().pendingClose?.id).toBe('ws-2');
    expect(leafIdsIn('ws-2')).toHaveLength(1);
    await press('Escape');
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(3);
    await press('x');
    await press(getWorkspaceUiSnapshot().pendingClose!.char);
    await flush();
    expect(getActiveWorkspaceId()).toBe('ws-3');
    expect(getWorkspacesSnapshot().workspaces.map(workspace => workspace.id)).toEqual([first, 'ws-3']);
    // No Up required: selection stayed on the workspace row, not a pane.
    await press('x');
    expect(getWorkspaceUiSnapshot().pendingClose?.id).toBe('ws-3');
    await press(getWorkspaceUiSnapshot().pendingClose!.char);
    await flush();
    expect(getActiveWorkspaceId()).toBe(first);
    await press('x');
    expect(getWorkspaceUiSnapshot().pendingClose?.id).toBe(first);
    await press(getWorkspaceUiSnapshot().pendingClose!.char);
    const replacement = getActiveWorkspaceId();
    expect(replacement).not.toBe(first);
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
    expect(leafIdsIn(replacement)).toHaveLength(1);
    expect(getWallHandle(first)).toBeNull();
    expect(leafIdsIn(replacement)).not.toContain('pane-a');
    await press('x');
    expect(getWorkspaceUiSnapshot().pendingClose?.id).toBe(replacement);
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

  it('highlights tabs without switching; Enter activates in command mode, renames the active tab, or creates into a live pane', async () => {
    const first = getActiveWorkspaceId();
    createWorkspace({ id: 'ws-2', activate: false });
    await render(<><WorkspaceStrip /><WorkspaceWindow initialPaneIds={['pane-a']} /></>);
    const press = async (key: string, location = 0) => {
      await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key, location, bubbles: true, cancelable: true })); });
      await flush();
    };
    const renaming = () => container.querySelector<HTMLInputElement>('[data-workspace-rename-for]')?.dataset.workspaceRenameFor;
    const cancelRename = async () => {
      const input = container.querySelector<HTMLInputElement>('[data-workspace-rename-for]')!;
      await act(async () => { input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); });
      await flush();
      expect(renaming()).toBeUndefined();
    };
    await press('ArrowUp');
    await press('ArrowRight');
    expect(getActiveWorkspaceId()).toBe(first);
    await press('ArrowDown');
    await press('Enter');
    expect(getActiveWorkspaceId()).toBe(first);
    expect(wallFor(first).querySelector('[data-session-id="pane-a"][data-focused="true"]')).not.toBeNull();

    await press('Shift', 1);
    await press('Shift', 2);
    await press('ArrowUp');
    await press('Enter');
    expect(renaming()).toBe(first);
    expect(wallFor(first).querySelector('[data-focused="true"]')).toBeNull();
    await cancelRename();

    await press('ArrowRight');
    await press('Enter');
    expect(getActiveWorkspaceId()).toBe('ws-2');
    expect(renaming()).toBeUndefined();
    expect(wallFor('ws-2').querySelector('[data-focused="true"]')).toBeNull();
    // The ring stayed on the now-active tab, so a second Enter renames it.
    await press('Enter');
    expect(renaming()).toBe('ws-2');
    await cancelRename();

    await press('ArrowRight'); // +
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(2);
    await press('Enter');
    const created = getActiveWorkspaceId();
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(3);
    expect(created).not.toBe('ws-2');
    expect(wallFor(created).querySelector('[data-focused="true"]')).not.toBeNull();
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
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'n', bubbles: true, cancelable: true })); });
    await flush();
    // The Wall that `n` activated must not answer it too and switch straight back.
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
    setTerminalActivity('pane-a', { status: 'ALERT_RINGING' });
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
    await act(async () => { expect(await handle.closeAll('silent')).toBeNull(); });
    await flush();
    expect(handle.surfaceIds()).toEqual([]);
    expect(leafIdsIn('ws-2')).toEqual([]);
  });

  it.each([true, false])('a refused closure preserves Workspace visibility (active: %s) and re-arms its auto-spawn', async (activate) => {
    const first = getActiveWorkspaceId();
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2', activate }); });
    await flush();
    const handle = getWallHandle('ws-2')!;
    const [paneId] = handle.surfaceIds();
    addPlainNote(paneId, 'unsaved');
    vi.spyOn(fake.notepadArchive, 'save').mockRejectedValue(new Error('disk is full'));

    let refusal: string | null = null;
    await act(async () => { refusal = await handle.closeAll('silent'); });
    await flush();
    expect(refusal).toContain('notepad archive failed');
    expect(handle.surfaceIds()).toEqual([paneId]);
    expect(workspaceMotion.workspaceIsCollapsed('ws-2')).toBe(false);
    expect(getActiveWorkspaceId()).toBe(activate ? 'ws-2' : first);
    expect(wallFor('ws-2').classList.contains('invisible')).toBe(!activate);

    // The flag is cleared, so the Wall's "always one pane" rule works again.
    vi.mocked(fake.notepadArchive.save).mockResolvedValue(undefined);
    await act(async () => { await handle.closeAll('discard'); });
    await flush();
    expect(handle.surfaceIds()).toEqual([]);
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

  it.each([SURFACE_CONTROL_METHODS.split, SURFACE_CONTROL_METHODS.tool])('refuses %s while its Workspace is closing', async (method) => {
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();
    const handle = getWallHandle('ws-2')!;
    const [paneId] = handle.surfaceIds();
    const respond = vi.fn();

    await act(async () => {
      // Dispatched INSIDE the walk: `dor split` from a member pane still routes
      // here, and a Surface born behind the walk would ride the unmount out.
      const closing = handle.closeAll('silent');
      handle.handleDorControl({
        requestId: 'r1',
        method,
        surfaceId: paneId,
        params: { direction: 'right' },
        respond,
      });
      expect(await closing).toBeNull();
    });
    await flush();

    expect(respond).toHaveBeenCalledWith({ ok: false, error: 'this workspace is closing' });
    expect(handle.surfaceIds()).toEqual([]);
    expect(leafIdsIn('ws-2')).toEqual([]);
  });

  it('names each Workspace its own agent-browser session for the same --key', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2', name: 'build' }); });
    await flush();

    /** `dor ab --key default` asking whichever Workspace will hold the browser
     *  what that key's session is called. */
    const sessionFor = (workspaceId: string): string => {
      const respond = vi.fn();
      getWallHandle(workspaceId)!.handleDorControl({
        requestId: 'r1',
        method: SURFACE_CONTROL_METHODS.resolveAgentBrowser,
        params: { key: 'default' },
        respond,
      });
      expect(respond).toHaveBeenCalledWith({ ok: true, result: { session: expect.any(String) } });
      return respond.mock.calls[0][0].result.session;
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

    await press('c');
    const ids = () => getWorkspacesSnapshot().workspaces.map((workspace) => workspace.id);
    expect(ids()).toHaveLength(2);
    const second = ids()[1];
    expect(getActiveWorkspaceId()).toBe(second);

    await press('p');
    expect(getActiveWorkspaceId()).toBe(first);
    await press('n');
    expect(getActiveWorkspaceId()).toBe(second);
    await press('1');
    expect(getActiveWorkspaceId()).toBe(first);
    // Out of range does nothing rather than wrapping.
    await press('9');
    expect(getActiveWorkspaceId()).toBe(first);

    // Exactly one Wall dispatches, so two mounted Walls create one Workspace.
    await press('c');
    expect(ids()).toHaveLength(3);
  });

  it('reports a fresh Workspace as untouched with nothing running', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    const handle = getWallHandle(first)!;
    expect(handle.hasTouchedSurfaces()).toBe(false);
    expect(handle.runningCount()).toBe(0);
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
  act(() => handle.handleDorControl({ requestId: 'late-tool', method: SURFACE_CONTROL_METHODS.tool,
    params: { name: 'storybook', cwd: '/repo' }, respond: late }));
  await flush();
  await act(async () => { await handle.closeAll('discard'); });
  await act(async () => gate.resolve(lookup));
  await flush();
  expect(late).toHaveBeenCalledWith({ ok: false, error: 'this workspace is closing' });
  expect(handle.surfaceIds()).toEqual([]);
});

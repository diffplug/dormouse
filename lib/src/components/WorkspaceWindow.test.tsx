/**
 * @vitest-environment jsdom
 *
 * The Window composition: one mounted Wall per Workspace, exactly one active,
 * and a switch that costs no Session anything (docs/specs/layout.md →
 * "Workspaces").
 */
import { StrictMode, act } from 'react';
import { type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { WorkspaceWindow } from './WorkspaceWindow';
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
import { previousWorkspaceSession, publishWorkspaceSession, resetWindowSessionAggregator } from '../lib/window-session-aggregator';
import { resetWorkspaceUi } from '../lib/workspace-ui-store';
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

/** Every mounted kill confirmation, whichever Wall rendered it. */
function killConfirms(): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>('#kill-confirm-title')];
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
    const ringBefore = getActivitySnapshot().get('pane-a')!.ringSeq;
    const leafBefore = wallFor(first).querySelector('[data-lath-leaf="pane-a"]');
    const paneBefore = wallFor(first).querySelector('[data-session-id="pane-a"]');

    await act(async () => { createWorkspace({ id: 'ws-2' }); });
    await flush();
    await act(async () => { setActiveWorkspace(first); });
    await flush();

    // A switch flips a prop; it never unmounts a leaf, so nothing calls
    // mountElement / resumeTerminal / restoreTerminal and `ringSeq` cannot
    // advance (docs/specs/glossary.md → "Invariants" I8).
    expect(wallFor(first).querySelector('[data-lath-leaf="pane-a"]')).toBe(leafBefore);
    expect(wallFor(first).querySelector('[data-session-id="pane-a"]')).toBe(paneBefore);
    expect(getActivitySnapshot().get('pane-a')!.ringSeq).toBe(ringBefore);
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

  it('a refused closure leaves the Workspace intact and re-arms its auto-spawn', async () => {
    await render();
    await act(async () => { createWorkspace({ id: 'ws-2' }); });
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

    // The flag is cleared, so the Wall's "always one pane" rule works again.
    vi.mocked(fake.notepadArchive.save).mockResolvedValue(undefined);
    await act(async () => { await handle.closeAll('discard'); });
    await flush();
    expect(handle.surfaceIds()).toEqual([]);
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

  it('refuses a Surface-creating dor request while its Workspace is closing', async () => {
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
        method: SURFACE_CONTROL_METHODS.split,
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
    expect(wallFor('ws-2').contains(killConfirms()[0])).toBe(true);

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

  it('refuses to close the last Workspace', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    expect(closeWorkspace(first)).toBe(false);
    expect(getWorkspacesSnapshot().workspaces).toHaveLength(1);
    expect(walls()).toHaveLength(1);
  });

  it('reports a fresh Workspace as untouched with nothing running', async () => {
    const first = getWorkspacesSnapshot().workspaces[0].id;
    await render();
    const handle = getWallHandle(first)!;
    expect(handle.hasTouchedSurfaces()).toBe(false);
    expect(handle.runningCount()).toBe(0);
  });
});

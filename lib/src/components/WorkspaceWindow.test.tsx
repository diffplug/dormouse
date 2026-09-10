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
import { WorkspaceWindow } from './WorkspaceWindow';
import { setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { clearAllNotepads, addPlainNote } from '../lib/notepad/notepad-store';
import { __resetArchiveServiceForTests } from '../lib/notepad/archive-service';
import { getActivitySnapshot, setTerminalActivity } from '../lib/terminal-registry';
import { getWallHandle, listWallHandles, resetWallHandles } from './wall/wall-handles';
import { mountWallHarness, type WallHarness } from './wall/wall-test-utils';
import { getWorkspaceSurfacesSnapshot, resetWorkspaceSurfaces } from '../lib/workspace-surfaces';
import { resetWindowSessionAggregator } from '../lib/window-session-aggregator';
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

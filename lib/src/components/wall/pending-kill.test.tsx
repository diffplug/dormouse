/**
 * @vitest-environment jsdom
 *
 * Labs: No-confirm delayed kill (`docs/specs/reopen.md`): a close that would
 * ask becomes a pending kill — out of the layout at once, its process Live —
 * until a countdown finalizes it or the user restores the same Surface.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS, WINDOW_CONTROL_METHODS } from 'dor/protocol';
import { Wall } from '../Wall';
import { setPlatform } from '../../lib/platform';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import * as terminalRegistry from '../../lib/terminal-registry';
import { _resetLabsSettingsForTesting, setDelayedKillSetting } from '../../lib/labs-settings';
import {
  _resetPendingKillsForTesting, finalizePendingKill, getPendingKills, pendingKillKey, restorePendingKill,
} from '../../lib/pending-kills';
import { _resetReopenStackForTesting, _reopenRecordsForTesting } from '../../lib/reopen-stack';
import { mountWallHarness, type WallHarness } from './wall-test-utils';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
import { cancelEditorClose, getEditorClosePrompt } from '../../lib/tool-editor';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../TerminalPane', () => ({
  TerminalPane: ({ id }: { id: string }) => <div data-testid="terminal-pane" data-session-id={id} />,
}));

let harness: WallHarness;
let fake: FakePtyAdapter;

beforeEach(() => {
  fake = new FakePtyAdapter();
  Object.assign(fake, { offersLabs: true });
  setPlatform(fake);
  harness = mountWallHarness();
  setDelayedKillSetting(true);
  // Every shell here has been typed into: its close would ask.
  vi.spyOn(terminalRegistry, 'isUntouched').mockReturnValue(false);
});

afterEach(() => {
  harness.dispose();
  vi.restoreAllMocks();
  _resetPendingKillsForTesting();
  _resetReopenStackForTesting();
  _resetLabsSettingsForTesting();
});

const WEB_PARAMS = { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173/docs' };

async function renderTwoShells(): Promise<void> {
  await act(async () => harness.root.render(<Wall initialPaneIds={['surface:11', 'surface:12']} initialMode="command" />));
  await harness.flush();
}

const leafIds = (): string[] => Array.from(harness.container.querySelectorAll<HTMLElement>('[data-lath-leaf]')).map(el => el.dataset.lathLeaf!);
const confirmKillOverlay = () => Array.from(document.body.querySelectorAll('h2')).find(h => h.textContent === 'Confirm kill') ?? null;

function control<T>(method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; result?: T }> {
  return new Promise((resolve) => {
    act(() => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: { method, params, respond: resolve } }));
    });
  });
}

async function clickKill(id: string): Promise<void> {
  await act(async () => {
    harness.container.querySelector<HTMLButtonElement>(`[data-lath-leaf="${id}"] button[aria-label="Kill"]`)!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
  await harness.flush();
}

describe('a pending kill', () => {
  it('takes a touched shell out of the layout at once, with no prompt, no Door, and its Session alive', async () => {
    const dispose = vi.spyOn(terminalRegistry, 'disposeSession');
    await renderTwoShells();
    await clickKill('surface:12');
    expect(confirmKillOverlay()).toBeNull();
    expect(leafIds()).toEqual(['surface:11']);
    expect(harness.container.querySelector('[data-door-id]')).toBeNull();
    expect(getPendingKills().map(kill => [kill.id, kill.label])).toEqual([['surface:12', 'Terminal']]);
    expect(dispose).not.toHaveBeenCalledWith('surface:12');
  });

  it('is gone from dor listings, and a dor command naming it fails as a pending kill', async () => {
    await renderTwoShells();
    await clickKill('surface:12');
    const listed = await control<{ surfaces: Array<{ id: string }> }>(SURFACE_CONTROL_METHODS.list);
    expect(listed.result!.surfaces.map(surface => surface.id)).toEqual(['surface:11']);
    for (const surface of ['surface:12', 'surface:12']) {
      expect(await control(SURFACE_CONTROL_METHODS.read, { surface })).toEqual({ ok: false, error: `surface '${surface}' is a pending kill` });
    }
  });

  it('refuses a dor command its own process makes while it is pending', async () => {
    await renderTwoShells();
    await clickKill('surface:12');
    const answer = await new Promise<{ ok: boolean; error?: string }>(resolve => {
      act(() => { window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
        method: SURFACE_CONTROL_METHODS.split, surfaceId: 'surface:12', params: {}, respond: resolve,
      } })); });
    });
    expect(answer).toEqual({ ok: false, error: "surface 'surface:12' is a pending kill" });
    expect(leafIds()).toEqual(['surface:11']);
  });

  it('restores the same Surface, its id intact', async () => {
    await renderTwoShells();
    await clickKill('surface:12');
    await act(async () => { restorePendingKill(pendingKillKey('surface', 'surface:12')); });
    await harness.flush();
    expect(leafIds().sort()).toEqual(['surface:11', 'surface:12']);
    const listed = await control<{ surfaces: Array<{ id: string }> }>(SURFACE_CONTROL_METHODS.list);
    expect(listed.result!.surfaces.map(surface => surface.id)).toEqual(['surface:11', 'surface:12']);
  });

  it('finalizes through the kill path', async () => {
    const dispose = vi.spyOn(terminalRegistry, 'disposeSession');
    await renderTwoShells();
    await clickKill('surface:12');
    // The countdown's end is the store's (`pending-kills.test.ts`); this is what it runs.
    act(() => { finalizePendingKill(pendingKillKey('surface', 'surface:12')); });
    expect(dispose).toHaveBeenCalledWith('surface:12');
    expect(getPendingKills()).toEqual([]);
    expect((await control(SURFACE_CONTROL_METHODS.read, { surface: 'surface:12' })).error).toBe("surface 'surface:12' was not found");
  });

  it('takes an unsaved Tool without asking, its page parked until restore or finalize', async () => {
    const params = { surfaceType: 'tool', command: 'dor __view-file /repo/a.md', cwd: '/repo', toolScope: 'builtin', toolName: 'file', toolRender: 'iframe', toolPort: 'announced' };
    await act(async () => harness.root.render(<Wall restoredLathLayout={{ version: 1, tree: { root: { kind: 'split', dir: 'row', children: [
      { node: { kind: 'leaf', id: 'surface:11' }, weight: 0.5 }, { node: { kind: 'leaf', id: 'surface:editor' }, weight: 0.5 },
    ] } }, leafMeta: {
      'surface:11': { component: 'terminal', tabComponent: 'terminal', title: 'shell' },
      'surface:editor': { component: 'tool', tabComponent: 'tool', title: 'a.md', params },
    } }} initialMode="command" />));
    await harness.flush();
    act(() => recordToolDirty('surface:editor', true));
    try {
      await clickKill('surface:editor');
      expect(getEditorClosePrompt()).toBeNull();
      expect(getPendingKills().map(kill => [kill.id, kill.label])).toEqual([['surface:editor', 'Tool']]);
      // Parked, not unmounted: the frame and its edits stay in the DOM.
      expect(harness.container.querySelector('[data-lath-leaf="surface:editor"]')).not.toBeNull();
      await act(async () => { restorePendingKill(pendingKillKey('surface', 'surface:editor')); });
      await harness.flush();
      expect(getPendingKills()).toEqual([]);
      expect(getEditorClosePrompt()).toBeNull();
    } finally {
      resetToolDirty();
      cancelEditorClose();
    }
  });

  it('comes back from a Door as a Door', async () => {
    await renderTwoShells();
    await act(async () => { harness.container.querySelector<HTMLElement>('[data-lath-leaf="surface:12"] [aria-label="Minimize"]')!.click(); });
    await harness.flush();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true })); });
    await harness.flushFrame();
    await harness.flush();
    expect(harness.container.querySelector('[data-door-id]')).toBeNull();
    expect(leafIds()).toEqual(['surface:11']);
    await act(async () => { restorePendingKill(pendingKillKey('surface', 'surface:12')); });
    await harness.flush();
    expect(harness.container.querySelector<HTMLElement>('[data-door-id]')?.dataset.doorId).toBe('surface:12');
  });

  it('is what Reopen takes when it is newer than any reopen record', async () => {
    await act(async () => harness.root.render(<Wall
      restoredLathLayout={{ version: 1, tree: { root: { kind: 'split', dir: 'row', children: [
        { node: { kind: 'leaf', id: 'surface:11' }, weight: 0.5 }, { node: { kind: 'leaf', id: 'surface:web' }, weight: 0.5 },
      ] } }, leafMeta: {
        'surface:11': { component: 'terminal', tabComponent: 'terminal', title: 'shell' },
        'surface:web': { component: 'browser', tabComponent: 'surface', title: 'docs', params: WEB_PARAMS },
      } }}
      initialMode="command"
    />));
    await harness.flush();
    // A reopenable close is unchanged: immediate, onto the reopen stack.
    await clickKill('surface:web');
    expect(_reopenRecordsForTesting()).toHaveLength(1);
    expect(getPendingKills()).toEqual([]);
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 2)); });
    await clickKill('surface:11');
    expect(getPendingKills().map(kill => kill.id)).toEqual(['surface:11']);
    expect((await control(WINDOW_CONTROL_METHODS.reopen)).result).toEqual({ status: 'reopened', kind: 'surface', surfaceId: 'surface:11' });
    expect(getPendingKills()).toEqual([]);
    expect(_reopenRecordsForTesting()).toHaveLength(1);
  });
});

describe('unchanged by the toggle', () => {
  it('asks as before when the toggle is off', async () => {
    setDelayedKillSetting(false);
    await renderTwoShells();
    await clickKill('surface:12');
    expect(confirmKillOverlay()).not.toBeNull();
    expect(getPendingKills()).toEqual([]);
  });

  it('keeps a dor command close immediate', async () => {
    const dispose = vi.spyOn(terminalRegistry, 'disposeSession');
    await renderTwoShells();
    await control(SURFACE_CONTROL_METHODS.kill, { surface: 'surface:12', confirmation: { mode: 'dangerously' } });
    await harness.flush();
    expect(getPendingKills()).toEqual([]);
    expect(dispose).toHaveBeenCalledWith('surface:12');
  });

  it('finalizes a Workspace\'s own pending kills when it closes', async () => {
    const dispose = vi.spyOn(terminalRegistry, 'disposeSession');
    await renderTwoShells();
    await clickKill('surface:12');
    act(() => harness.root.unmount());
    expect(dispose).toHaveBeenCalledWith('surface:12');
    expect(getPendingKills()).toEqual([]);
    harness = mountWallHarness();
  });
});

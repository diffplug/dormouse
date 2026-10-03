/**
 * @vitest-environment jsdom
 *
 * Reopen (`docs/specs/reopen.md`): a reopenable close leaves a record, and the
 * verb — command-mode `u` or `dor reopen` — rebuilds it as a new Surface.
 */
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SURFACE_CONTROL_METHODS, WINDOW_CONTROL_METHODS } from 'dor/protocol';
import { Wall } from '../Wall';
import { setPlatform } from '../../lib/platform';
import { FakePtyAdapter } from '../../lib/platform/fake-adapter';
import { _reopenRecordsForTesting, _resetReopenStackForTesting, popReopenRecord, pushReopenRecord, type SurfaceReopenRecord } from '../../lib/reopen-stack';
import { DEFAULT_WORKSPACE_ID } from '../../lib/session-types';
import * as terminalRegistry from '../../lib/terminal-registry';
import { recordToolDirty, resetToolDirty } from '../../lib/tool-dirty-store';
import { mountWallHarness, type WallHarness } from './wall-test-utils';
import { getWallHandle } from './wall-handles';
import { reopenClosed } from './reopen';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

vi.mock('../TerminalPane', () => ({
  TerminalPane: ({ id }: { id: string }) => <div data-testid="terminal-pane" data-session-id={id} />,
}));

let harness: WallHarness;

beforeEach(() => {
  setPlatform(new FakePtyAdapter());
  harness = mountWallHarness();
  _resetReopenStackForTesting();
});

afterEach(() => {
  harness.dispose();
  vi.restoreAllMocks();
  _resetReopenStackForTesting();
});

const WEB_PARAMS = { surfaceType: 'browser', renderMode: 'iframe', url: 'http://localhost:5173/docs' };

/** A terminal beside an iframe browser, in command mode. */
async function renderTerminalBesideBrowser(): Promise<void> {
  await act(async () => harness.root.render(<Wall
    restoredLathLayout={{
      version: 1,
      tree: { root: { kind: 'split', dir: 'row', children: [
        { node: { kind: 'leaf', id: 'pane-a' }, weight: 0.5 },
        { node: { kind: 'leaf', id: 'web' }, weight: 0.5 },
      ] } },
      leafMeta: {
        'pane-a': { component: 'terminal', tabComponent: 'terminal', title: 'shell' },
        web: { component: 'browser', tabComponent: 'surface', title: 'docs', params: WEB_PARAMS },
      },
    }}
    initialMode="command"
  />));
  await harness.flush();
}

function control<T>(method: string, params: Record<string, unknown> = {}): Promise<{ ok: boolean; error?: string; result?: T }> {
  return new Promise((resolve) => {
    act(() => {
      window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: { method, params, respond: resolve } }));
    });
  });
}

const leafIds = (): string[] => Array.from(harness.container.querySelectorAll<HTMLElement>('[data-lath-leaf]')).map(el => el.dataset.lathLeaf!);

async function pressU(): Promise<void> {
  await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'u', bubbles: true, cancelable: true })); });
  await harness.flush();
}

describe('the reopen stack', () => {
  const record = (n: number): SurfaceReopenRecord => ({
    kind: 'surface', closedAt: n, workspaceId: DEFAULT_WORKSPACE_ID,
    pane: { id: `p${n}`, cwd: null, title: '', untouched: true },
    meta: { component: 'terminal', tabComponent: 'terminal', title: '' },
    placement: { kind: 'door', index: 0, token: null },
  });

  it('pops newest first and keeps only the newest 20', () => {
    for (let n = 1; n <= 25; n++) pushReopenRecord(record(n));
    expect(_reopenRecordsForTesting()).toHaveLength(20);
    expect(popReopenRecord()?.closedAt).toBe(25);
    expect(popReopenRecord()?.closedAt).toBe(24);
    expect(_reopenRecordsForTesting().at(-1)?.closedAt).toBe(6);
  });
});

describe('Reopen', () => {
  it('rebuilds a reopenable close where it sat, as a new Surface with a new ref', async () => {
    await renderTerminalBesideBrowser();
    const killed = await control<{ surfaceRef: string }>(SURFACE_CONTROL_METHODS.kill, { surface: 'web', confirmation: { mode: 'dangerously' } });
    expect(killed.ok).toBe(true);
    await harness.flush();
    expect(leafIds()).toEqual(['pane-a']);
    expect(_reopenRecordsForTesting()).toHaveLength(1);

    await pressU();
    const reopened = leafIds().find(id => id !== 'pane-a')!;
    expect(reopened).not.toBe('web');
    // Back on the right of pane-a, as it sat.
    const layout = getWallHandle(DEFAULT_WORKSPACE_ID)!.serializeNow().lathLayout as { tree: { root: unknown }; leafMeta: Record<string, { params?: unknown }> };
    expect(layout.tree.root).toMatchObject({ kind: 'split', dir: 'row', children: [{ node: { id: 'pane-a' } }, { node: { id: reopened } }] });
    expect(layout.leafMeta[reopened].params).toMatchObject(WEB_PARAMS);
    const listed = await control<{ surfaces: Array<{ id: string; ref: string; url?: string }> }>(SURFACE_CONTROL_METHODS.list);
    const surface = listed.result!.surfaces.find(s => s.id === reopened)!;
    // surface:1 is pane-a and surface:2 the closed browser, retired for good.
    expect(surface.ref).toBe('surface:3');
    expect(_reopenRecordsForTesting()).toHaveLength(0);
  });

  it('records nothing for a close that is not reopenable', async () => {
    // pane-a has no Session yet, so it reads as touched and confirms.
    await renderTerminalBesideBrowser();
    await control(SURFACE_CONTROL_METHODS.kill, { surface: 'pane-a', confirmation: { mode: 'dangerously' } });
    await harness.flush();
    expect(leafIds()).toEqual(['web']);
    expect(_reopenRecordsForTesting()).toHaveLength(0);
  });

  it('closes a clean built-in viewer at once, and reopens it running the same command', async () => {
    const params = { surfaceType: 'tool', command: 'dor __view-file /repo/README.md', toolArgv: ['dor', '__view-file', '/repo/README.md'], cwd: '/repo', toolScope: 'builtin', toolName: 'file', toolRender: 'iframe', toolPort: 'announced' };
    const restore = vi.spyOn(terminalRegistry, 'restoreTerminal').mockImplementation(() => ({}) as ReturnType<typeof terminalRegistry.restoreTerminal>);
    await act(async () => harness.root.render(<Wall
      restoredLathLayout={{
        version: 1,
        tree: { root: { kind: 'split', dir: 'row', children: [
          { node: { kind: 'leaf', id: 'pane-a' }, weight: 0.5 },
          { node: { kind: 'leaf', id: 'viewer' }, weight: 0.5 },
        ] } },
        leafMeta: {
          'pane-a': { component: 'terminal', tabComponent: 'terminal', title: 'shell' },
          viewer: { component: 'tool', tabComponent: 'tool', title: 'README.md', params },
        },
      }}
      initialMode="command"
    />));
    await harness.flush();
    act(() => {
      terminalRegistry.applyTerminalSemanticEvents('viewer', [{ type: 'commandLine', commandLine: params.command }, { type: 'commandStart' }]);
      recordToolDirty('viewer', false);
    });
    try {
      await act(async () => {
        harness.container.querySelector<HTMLButtonElement>('[data-lath-leaf="viewer"] button[aria-label="Kill"]')!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      });
      await harness.flush();
      expect(document.body.textContent).not.toContain('Confirm kill');
      expect(leafIds()).toEqual(['pane-a']);
      await pressU();
      const reopened = leafIds().find(id => id !== 'pane-a')!;
      expect(restore).toHaveBeenCalledWith(reopened, expect.objectContaining({ command: params.command, requireIntegration: true }));
    } finally {
      terminalRegistry.removeTerminalPaneState('viewer');
      resetToolDirty();
    }
  });

  it('answers dor reopen with the reopened ref, and refuses an empty stack', async () => {
    await renderTerminalBesideBrowser();
    expect(await control(WINDOW_CONTROL_METHODS.reopen)).toEqual({ ok: false, error: 'Nothing to reopen' });
    await control(SURFACE_CONTROL_METHODS.kill, { surface: 'web', confirmation: { mode: 'dangerously' } });
    await harness.flush();
    const reopened = await control<{ kind: string; surfaceRef: string }>(WINDOW_CONTROL_METHODS.reopen);
    expect(reopened.result).toMatchObject({ status: 'reopened', kind: 'surface', surfaceRef: 'surface:3' });
    await harness.flush();
    expect(leafIds()).toHaveLength(2);
  });

  it('reopens a closed window the host holds when it closed after this Window\'s newest record', async () => {
    const fake = new FakePtyAdapter();
    const reopenClosedWindow = vi.fn(async (newerThan: number) => newerThan < 1000);
    Object.assign(fake, { reopenClosedWindow });
    setPlatform(fake);
    await renderTerminalBesideBrowser();
    await control(SURFACE_CONTROL_METHODS.kill, { surface: 'web', confirmation: { mode: 'dangerously' } });
    await harness.flush();
    const [record] = _reopenRecordsForTesting();
    // The window closed later than the Surface did: it comes back first.
    record.closedAt = 500;
    expect((await control(WINDOW_CONTROL_METHODS.reopen)).result).toEqual({ status: 'reopened', kind: 'window' });
    expect(reopenClosedWindow).toHaveBeenLastCalledWith(500);
    expect(_reopenRecordsForTesting()).toHaveLength(1);
    // The Surface closed later than any window: this Window's own record wins.
    record.closedAt = 2000;
    expect((await control(WINDOW_CONTROL_METHODS.reopen)).result).toMatchObject({ kind: 'surface' });
    expect(reopenClosedWindow).toHaveBeenLastCalledWith(2000);
  });

  it('records a close once, however many kills reach it during its fade', async () => {
    await renderTerminalBesideBrowser();
    // The second lands after the first has started the fade, before it removes the pane.
    vi.useFakeTimers({ toFake: ['setTimeout'] });
    try {
      for (let i = 0; i < 2; i++) {
        await act(async () => {
          window.dispatchEvent(new CustomEvent('dormouse:control-request', { detail: {
            method: SURFACE_CONTROL_METHODS.kill, params: { surface: 'web', confirmation: { mode: 'dangerously' } }, respond: () => {},
          } }));
          for (let tick = 0; tick < 10; tick++) await Promise.resolve();
        });
      }
      vi.runAllTimers();
    } finally {
      vi.useRealTimers();
    }
    await harness.flush();
    expect(_reopenRecordsForTesting()).toHaveLength(1);
  });

  it('reopens a closed preview viewer pinned, leaving the slot to a newer preview', async () => {
    const params = { surfaceType: 'tool', command: 'dor __view-file /repo/a.md', cwd: '/repo', toolScope: 'builtin', toolName: 'file', toolPreview: true };
    vi.spyOn(terminalRegistry, 'restoreTerminal').mockImplementation(() => ({}) as ReturnType<typeof terminalRegistry.restoreTerminal>);
    await act(async () => harness.root.render(<Wall
      restoredLathLayout={{ version: 1, tree: { root: { kind: 'split', dir: 'row', children: [
        { node: { kind: 'leaf', id: 'pane-a' }, weight: 0.5 }, { node: { kind: 'leaf', id: 'slot' }, weight: 0.5 },
      ] } }, leafMeta: {
        'pane-a': { component: 'terminal', tabComponent: 'terminal', title: 'shell' },
        slot: { component: 'tool', tabComponent: 'tool', title: 'a.md', params },
      } }}
      initialMode="command"
    />));
    await harness.flush();
    act(() => {
      terminalRegistry.applyTerminalSemanticEvents('slot', [{ type: 'commandLine', commandLine: params.command }, { type: 'commandStart' }]);
      recordToolDirty('slot', false);
    });
    try {
      await control(SURFACE_CONTROL_METHODS.kill, { surface: 'slot', confirmation: { mode: 'dangerously' } });
      await harness.flush();
      expect(_reopenRecordsForTesting()[0]?.kind === 'surface' && _reopenRecordsForTesting()[0].meta.params).not.toHaveProperty('toolPreview');
    } finally {
      terminalRegistry.removeTerminalPaneState('slot');
      resetToolDirty();
    }
  });

  it('falls back to this Window\'s own records when the host cannot answer for closed windows', async () => {
    const fake = new FakePtyAdapter();
    Object.assign(fake, { reopenClosedWindow: vi.fn(async () => { throw new Error('sessions dir unavailable'); }) });
    setPlatform(fake);
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    await renderTerminalBesideBrowser();
    await control(SURFACE_CONTROL_METHODS.kill, { surface: 'web', confirmation: { mode: 'dangerously' } });
    await harness.flush();
    expect((await control(WINDOW_CONTROL_METHODS.reopen)).result).toMatchObject({ kind: 'surface' });
  });

  it('refuses dor reopen as still mounting, keeping the record, when no Wall can take it', async () => {
    pushReopenRecord({
      kind: 'surface', closedAt: 1, workspaceId: DEFAULT_WORKSPACE_ID,
      pane: { id: 'p', cwd: null, title: '', untouched: true },
      meta: { component: 'terminal', tabComponent: 'terminal', title: '' },
      placement: { kind: 'door', index: 0, token: null },
    });
    await expect(reopenClosed({ gesture: false })).rejects.toThrow('is still mounting');
    expect(_reopenRecordsForTesting()).toHaveLength(1);
  });

  it('says so briefly when `u` finds nothing to reopen', async () => {
    await renderTerminalBesideBrowser();
    await pressU();
    expect(document.body.textContent).toContain('Nothing to reopen');
    expect(leafIds()).toEqual(['pane-a', 'web']);
  });

  it('closes a reopenable Door from the kill key as a Door, so it reopens as one', async () => {
    await renderTerminalBesideBrowser();
    // Minimizing leaves the Door selected in command mode.
    await act(async () => { harness.container.querySelector<HTMLElement>('[data-lath-leaf="web"] [aria-label="Minimize"]')!.click(); });
    await harness.flush();
    await act(async () => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'x', bubbles: true, cancelable: true })); });
    await harness.flushFrame();
    await harness.flush();
    expect(harness.container.querySelector('[data-door-id]')).toBeNull();
    expect(leafIds()).toEqual(['pane-a']);
    expect(_reopenRecordsForTesting()[0]?.placement.kind).toBe('door');
  });

  it('puts a reopened Door back at its slot on the Baseboard', async () => {
    await renderTerminalBesideBrowser();
    await act(async () => { harness.container.querySelector<HTMLElement>('[data-lath-leaf="web"] [aria-label="Minimize"]')!.click(); });
    await harness.flush();
    await control(SURFACE_CONTROL_METHODS.kill, { surface: 'web', confirmation: { mode: 'dangerously' } });
    await harness.flush();
    expect(harness.container.querySelector('[data-door-id]')).toBeNull();
    await pressU();
    const door = harness.container.querySelector<HTMLElement>('[data-door-id]');
    expect(door?.dataset.doorId).toBeDefined();
    expect(door?.dataset.doorId).not.toBe('web');
    expect(leafIds()).toEqual(['pane-a']);
  });
});

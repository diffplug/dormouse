// @vitest-environment jsdom
/**
 * A reaped Tool survives a save, a resume, a cold restore, and a Workspace
 * arrival as reaped — the mark, never the payload — with no process until it
 * is shown (`docs/specs/dor-tool.md` -> Reaping).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xterm/xterm', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-fit', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-image', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-serialize', () => import('./xterm-test-mock'));
vi.mock('@xterm/addon-unicode-graphemes', () => import('./xterm-test-mock'));

import { FakePtyAdapter, setPlatform } from './platform';
import type { SpawnPtyOptions } from './platform/types';
import { resumeOrRestoreFrom } from './reconnect';
import { assemblePersistedSession } from './session-save';
import { restoreSession } from './session-restore';
import type { PersistedPane, PersistedSession } from './session-types';
import { readPersistedSession } from './session-types';
import { disposeSession } from './terminal-registry';
import { registry } from './terminal-store';
import { getToolReap, isToolReaped, markToolReaped, resetToolReaps } from './tool-reap-store';

const toolParams = { surfaceType: 'tool', command: 'viewer --serve', toolRender: 'iframe', toolPort: 'announced' };

let fake: FakePtyAdapter & { reapsTools?: boolean };
let spawned: string[];

function session(panes: PersistedPane[]): PersistedSession {
  return { version: 3, panes, doors: [] };
}

const reapedPane: PersistedPane = {
  id: 'tool', title: 'Viewer', cwd: '/repo', untouched: false, surfaceType: 'tool', command: 'viewer --serve',
  tool: { render: 'iframe', port: 'announced', reaped: true },
  alert: { status: 'NOTHING_TO_SHOW', todo: true, notification: null },
};

beforeEach(() => {
  fake = new FakePtyAdapter();
  fake.reapsTools = true;
  spawned = [];
  const spawn = fake.spawnPty.bind(fake);
  fake.spawnPty = (id: string, options?: SpawnPtyOptions) => { spawned.push(id); spawn(id, options); };
  setPlatform(fake);
});

afterEach(() => {
  for (const id of ['tool', 'shell']) disposeSession(id);
  resetToolReaps();
});

describe('saving', () => {
  it('writes the reaped mark while the Tool is reaped, and drops it once it is not', () => {
    const panes = [{ id: 'tool', title: 'Viewer', surfaceType: 'tool' as const, params: toolParams }];
    markToolReaped('tool', { payload: '{"v":1,"state":1}', cwd: '/repo', alert: null });
    const saved = assemblePersistedSession(panes, [], undefined, undefined, undefined, null, null);
    expect(saved.panes[0].tool).toMatchObject({ reaped: true });
    expect(JSON.stringify(saved)).not.toContain('"state"');
    expect(readPersistedSession(saved)?.panes[0].tool?.reaped).toBe(true);
    resetToolReaps();
    // A previous record's mark is not carried past the rehydrate.
    const after = assemblePersistedSession(panes, [], undefined, undefined, undefined, saved, null);
    expect(after.panes[0].tool).not.toHaveProperty('reaped');
  });
});

describe('restoring', () => {
  it('rebuilds a reaped Tool with no process on cold restore, keeping its TODO for the rehydrate', () => {
    const shellPane: PersistedPane = { id: 'shell', title: 'zsh', cwd: '/repo', untouched: true };
    restoreSession(fake, { savedSession: session([reapedPane, shellPane]) });
    expect(spawned).toEqual(['shell']);
    expect(registry.get('tool')).toMatchObject({ exited: true, dormant: true });
    expect(isToolReaped('tool')).toBe(true);
    expect(getToolReap('tool')).toEqual({ payload: null, cwd: '/repo', alert: reapedPane.alert });
  });

  it('keeps a reaped Tool through a live resume, which would drop a pane with no PTY as stale', () => {
    const shellPane: PersistedPane = { id: 'shell', title: 'zsh', cwd: '/repo', untouched: true };
    const live = { ptys: [{ id: 'shell', alive: true }], replay: new Map<string, string>(), timedOut: false };
    const plan = resumeOrRestoreFrom(fake, live, { savedSession: session([reapedPane, shellPane]) });
    expect(plan.paneIds).toEqual(['tool', 'shell']);
    expect(spawned).toEqual([]);
    expect(isToolReaped('tool')).toBe(true);
    expect(registry.get('tool')?.dormant).toBe(true);
  });

  it('starts the Tool as before on a host that does not reap', () => {
    fake.reapsTools = false;
    restoreSession(fake, { savedSession: session([reapedPane]) });
    expect(spawned).toEqual(['tool']);
    expect(isToolReaped('tool')).toBe(false);
  });
});

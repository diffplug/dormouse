import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addPlainNote, clearAllNotepads, getNotes, notepadSurfaceIds } from '../../lib/notepad/notepad-store';
import { releaseWorkspaceForTransfer } from './workspace-transfer';
import type { PersistedSession } from '../../lib/session-types';

/**
 * The source half of a Workspace transfer. What matters is the order — a record
 * built while the Sessions are still live, notes taken before they are
 * forgotten, and the detach last — and that nothing here is a closure
 * (`docs/specs/standalone.md` → "Transfer").
 */

const released: string[] = [];
vi.mock('../../lib/terminal-registry', () => ({
  releaseSession: (id: string) => void released.push(id),
}));

const SESSION: PersistedSession = { version: 3, panes: [{ id: 'pane-a', title: 'a', cwd: '/tmp', untouched: false, alert: null }] };

beforeEach(() => {
  released.length = 0;
  clearAllNotepads();
});

function deps(order: string[] = [], overrides: Partial<Parameters<typeof releaseWorkspaceForTransfer>[0]> = {}) {
  return {
    workspaceId: 'ws-id',
    name: 'Deploys',
    serialize: vi.fn(async () => {
      order.push('serialize');
      return SESSION;
    }),
    surfaceIds: () => ['pane-a', 'browser-b'],
    hasTerminal: (id: string) => id.startsWith('pane-'),
    ...overrides,
  };
}

describe('releaseWorkspaceForTransfer', () => {
  it('serializes with a live cwd probe before anything is detached', async () => {
    const order: string[] = [];
    const d = deps(order, {});
    const payload = await releaseWorkspaceForTransfer({
      ...d,
      serialize: vi.fn(async (options) => {
        order.push(`serialize:${options?.probeCwd}`);
        expect(released).toEqual([]); // still live: the probe has PTYs to ask
        return SESSION;
      }),
    });

    expect(order).toEqual(['serialize:true']);
    expect(payload.workspace).toEqual({ id: 'ws-id', name: 'Deploys', session: SESSION });
  });

  it('detaches only the terminal Surfaces, and never kills one', async () => {
    const payload = await releaseWorkspaceForTransfer(deps());

    expect(payload.terminalIds).toEqual(['pane-a']);
    expect(payload.allIds).toEqual(['pane-a', 'browser-b']);
    // A browser Surface needs nothing: its agent-browser session lives in the
    // host and the target reopens from the persisted params.
    expect(released).toEqual(['pane-a']);
  });

  it('carries the notes and forgets them here, archiving nothing', async () => {
    addPlainNote('pane-a', 'keep me');
    addPlainNote('browser-b', 'and me');
    addPlainNote('elsewhere', 'not mine');

    const payload = await releaseWorkspaceForTransfer(deps());

    // The notes ride the payload…
    expect(payload.notepad.surfaces.map((surface) => surface.surfaceId)).toEqual(['pane-a', 'browser-b']);
    expect(payload.notepad.surfaces[0]!.notes[0]!.content).toMatchObject({ text: 'keep me' });
    // …and leave this Window, so the departed Workspace's notes do not linger.
    expect(getNotes('pane-a')).toHaveLength(0);
    // Another Workspace's notes are untouched.
    expect(notepadSurfaceIds()).toEqual(['elsewhere']);
  });
});

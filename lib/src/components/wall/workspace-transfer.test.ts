import { beforeEach, describe, expect, it, vi } from 'vitest';
import { addPlainNote, clearAllNotepads, getNotes, notepadSurfaceIds } from '../../lib/notepad/notepad-store';
import { prepareWorkspaceTransfer } from './workspace-transfer';
import type { PersistedSession } from '../../lib/session-types';

/**
 * The source half of a Workspace transfer. What matters is the order — a record
 * built while the Sessions are still live, notes taken before they are
 * forgotten, and the detach last — that the prepare touches nothing until the
 * host has accepted, and that nothing here is a closure
 * (`docs/specs/standalone.md` → "Transfer").
 */

const released: string[] = [];
vi.mock('../../lib/terminal-registry', () => ({
  releaseSession: (id: string) => void released.push(id),
}));

const helpers = new Map<string, { id: string }>();
const forgotten: string[] = [];
vi.mock('../../lib/helper-terminal', () => ({
  getHelper: (parentId: string) => helpers.get(parentId),
  forgetHelper: (parentId: string) => void forgotten.push(parentId),
}));

const SESSION: PersistedSession = { version: 3, panes: [{ id: 'pane-a', title: 'a', cwd: '/tmp', untouched: false, alert: null }] };

beforeEach(() => {
  released.length = 0;
  forgotten.length = 0;
  helpers.clear();
  clearAllNotepads();
});

function deps(order: string[] = [], overrides: Partial<Parameters<typeof prepareWorkspaceTransfer>[0]> = {}) {
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

describe('prepareWorkspaceTransfer', () => {
  it('serializes with a live cwd probe before anything is detached', async () => {
    const order: string[] = [];
    const d = deps(order, {});
    const prepared = await prepareWorkspaceTransfer({
      ...d,
      serialize: vi.fn(async (options) => {
        order.push(`serialize:${options?.probeCwd}`);
        expect(released).toEqual([]); // still live: the probe has PTYs to ask
        return SESSION;
      }),
    });

    expect(order).toEqual(['serialize:true']);
    expect(prepared.payload.workspace).toEqual({ id: 'ws-id', name: 'Deploys', session: SESSION });
  });

  it('touches nothing until the commit, so a refused transfer costs nothing', async () => {
    addPlainNote('pane-a', 'keep me');

    const prepared = await prepareWorkspaceTransfer(deps());

    // The host may still refuse — the target window can close between the
    // drag's last probe and the drop — so the Workspace is exactly as it was.
    expect(released).toEqual([]);
    expect(getNotes('pane-a')).toHaveLength(1);

    prepared.commit();
    expect(released).toEqual(['pane-a']);
    expect(getNotes('pane-a')).toHaveLength(0);
  });

  it('detaches only the terminal Surfaces, and never kills one', async () => {
    const prepared = await prepareWorkspaceTransfer(deps());
    prepared.commit();

    expect(prepared.payload.terminalIds).toEqual(['pane-a']);
    expect(prepared.payload.allIds).toEqual(['pane-a', 'browser-b']);
    // A browser Surface needs nothing: its agent-browser session lives in the
    // host and the target reopens from the persisted params.
    expect(released).toEqual(['pane-a']);
  });

  it('takes an open helper with its source instead of leaking it', async () => {
    // A helper is not a member Surface, so nothing else in the payload names it
    // — and one left behind is a shell owned by a Window that no longer shows
    // it, plus a stray pane on the next reload.
    helpers.set('pane-a', { id: 'helper-1' });

    const prepared = await prepareWorkspaceTransfer(deps());
    prepared.commit();

    // Directly after its source: the target's resume re-parents it, and that
    // needs the parent in the same slice.
    expect(prepared.payload.terminalIds).toEqual(['pane-a', 'helper-1']);
    // Not a member Surface: no notes, no pane, nothing to hydrate.
    expect(prepared.payload.allIds).toEqual(['pane-a', 'browser-b']);
    expect(released).toEqual(['pane-a', 'helper-1']);
    // Forgotten here, so the status poller stops and the source pane does not
    // re-open a helper it no longer holds.
    expect(forgotten).toEqual(['pane-a']);
  });

  it('carries the notes and forgets them here, archiving nothing', async () => {
    addPlainNote('pane-a', 'keep me');
    addPlainNote('browser-b', 'and me');
    addPlainNote('elsewhere', 'not mine');

    const prepared = await prepareWorkspaceTransfer(deps());
    prepared.commit();

    // The notes ride the payload…
    expect(prepared.payload.notepad.surfaces.map((surface) => surface.surfaceId)).toEqual(['pane-a', 'browser-b']);
    expect(prepared.payload.notepad.surfaces[0]!.notes[0]!.content).toMatchObject({ text: 'keep me' });
    // …and leave this Window, so the departed Workspace's notes do not linger.
    expect(getNotes('pane-a')).toHaveLength(0);
    // Another Workspace's notes are untouched.
    expect(notepadSurfaceIds()).toEqual(['elsewhere']);
  });
});

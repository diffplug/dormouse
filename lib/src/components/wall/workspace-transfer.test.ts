import { getWorkspaceUiSnapshot, setPendingWorkspaceClose, resetWorkspaceUi } from '../../lib/workspace-ui-store';
import { beforeEach, describe, expect, it, vi } from 'vitest';
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

const disposedBrowsers: string[] = [];
vi.mock('./agent-browser-surface-controller', () => ({
  disposeAgentBrowserSurfaceController: (id: string) => void disposedBrowsers.push(id),
}));

const helpers = new Map<string, { id: string }>();
const forgotten: string[] = [];
vi.mock('../../lib/helper-terminal', () => ({
  getHelper: (parentId: string) => helpers.get(parentId),
  forgetHelper: (parentId: string) => void forgotten.push(parentId),
}));

const SESSION: PersistedSession = { version: 3, panes: [{ id: 'pane-a', title: 'a', cwd: '/tmp', untouched: false, alert: null }] };

beforeEach(() => {
  resetWorkspaceUi();
  released.length = 0;
  forgotten.length = 0;
  disposedBrowsers.length = 0;
  helpers.clear();
});

function deps(order: string[] = [], overrides: Partial<Parameters<typeof prepareWorkspaceTransfer>[0]> = {}) {
  return {
    workspaceId: 'ws-id',
    naming: { name: 'Deploys', nameIsAuto: false },
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
  it('keeps the pending kill until commit, then dismisses only the departing Workspace', async () => {
    setPendingWorkspaceClose({ id: 'ws-id', char: 'q' });
    const prepared = await prepareWorkspaceTransfer(deps());
    expect(getWorkspaceUiSnapshot().pendingClose).toEqual({ id: 'ws-id', char: 'q' });
    prepared.commit();
    expect(getWorkspaceUiSnapshot().pendingClose).toBeNull();
    setPendingWorkspaceClose({ id: 'sibling', char: 'k' });
    prepared.commit();
    expect(getWorkspaceUiSnapshot().pendingClose).toEqual({ id: 'sibling', char: 'k' });
  });

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
    expect(prepared.payload.workspace).toEqual({ id: 'ws-id', name: 'Deploys', nameIsAuto: false, session: SESSION });
  });

  it('touches nothing until the commit, so a refused transfer costs nothing', async () => {
    const prepared = await prepareWorkspaceTransfer(deps());

    // The host may still refuse — the target window can close between the
    // drag's last probe and the drop — so the Workspace is exactly as it was.
    expect(released).toEqual([]);
    expect(disposedBrowsers).toEqual([]);

    prepared.commit();
    expect(released).toEqual(['pane-a']);
  });

  it('detaches only the terminal Surfaces, and never kills one', async () => {
    const prepared = await prepareWorkspaceTransfer(deps());
    prepared.commit();

    expect(prepared.payload.terminalIds).toEqual(['pane-a']);
    expect(prepared.payload.allIds).toEqual(['pane-a', 'browser-b']);
    expect(released).toEqual(['pane-a']);
    // A browser's session lives in the host, where the target attaches to it:
    // only this Window's viewer is released, its session left running.
    expect(disposedBrowsers).toEqual(['pane-a', 'browser-b']);
  });
});

/**
 * Pure wall-model logic: directory snapshots → MobileWall/MobileTerminalUi
 * session shapes, and the active-pane-change → setActivePane sequencing the
 * wall performs (exercised against a recording fake adapter).
 */

import { describe, expect, it } from 'vitest';
import type { DirectoryEntry } from 'server-lib-common';

import {
  activatePane,
  directorySessionItems,
  directoryWallSessions,
  type PaneActivator,
} from './wall-model';

function entry(surfaceId: string, over: Partial<DirectoryEntry> = {}): DirectoryEntry {
  return {
    paneRef: surfaceId,
    surfaceId,
    type: 'terminal',
    title: surfaceId,
    focused: false,
    ringing: false,
    hasTODO: false,
    ...over,
  };
}

describe('directoryWallSessions', () => {
  it('maps id = surfaceId and title from the entry, in Host order', () => {
    const sessions = directoryWallSessions([entry('s1', { title: 'zsh' }), entry('s2', { title: 'vim' })]);
    expect(sessions).toEqual([
      { id: 's1', title: 'zsh' },
      { id: 's2', title: 'vim' },
    ]);
  });

  it('falls back to a default title when the Host sends an empty one', () => {
    expect(directoryWallSessions([entry('s1', { title: '' })])).toEqual([{ id: 's1', title: 'Terminal' }]);
  });
});

describe('directorySessionItems', () => {
  it('marks the active pane and carries title/secondary', () => {
    const items = directorySessionItems(
      [entry('s1', { title: 'zsh', cwd: '/home/me' }), entry('s2', { title: 'vim' })],
      's2',
    );
    expect(items).toEqual([
      { id: 's1', title: 'zsh', secondary: '/home/me', active: false, status: undefined, todo: false },
      { id: 's2', title: 'vim', secondary: null, active: true, status: undefined, todo: false },
    ]);
  });

  it('maps ringing → ALERT_RINGING status and hasTODO → todo pill', () => {
    const [ringingItem, todoItem] = directorySessionItems(
      [entry('s1', { ringing: true }), entry('s2', { hasTODO: true })],
      null,
    );
    expect(ringingItem.status).toBe('ALERT_RINGING');
    expect(ringingItem.todo).toBe(false);
    expect(todoItem.status).toBeUndefined();
    expect(todoItem.todo).toBe(true);
  });

  it('uses activity as the secondary line when there is no cwd', () => {
    const [item] = directorySessionItems([entry('s1', { activity: 'running' })], null);
    expect(item.secondary).toBe('running');
  });

  it('prefers cwd over activity for the secondary line', () => {
    const [item] = directorySessionItems([entry('s1', { activity: 'running', cwd: '/tmp' })], null);
    expect(item.secondary).toBe('/tmp');
  });
});

describe('activatePane', () => {
  class RecordingAdapter implements PaneActivator {
    readonly calls: Array<{ id: string; cols?: number; rows?: number }> = [];
    async setActivePane(id: string, cols?: number, rows?: number): Promise<void> {
      this.calls.push({ id, cols, rows });
    }
  }

  it('forwards the pane dims and runs onAttached after the attach resolves', async () => {
    const adapter = new RecordingAdapter();
    const order: string[] = [];
    await activatePane(adapter, 's1', { cols: 40, rows: 60 }, (id) => order.push(`attached:${id}`));

    expect(adapter.calls).toEqual([{ id: 's1', cols: 40, rows: 60 }]);
    expect(order).toEqual(['attached:s1']);
  });

  it('passes undefined dims when none are known (adapter default + registry corrects)', async () => {
    const adapter = new RecordingAdapter();
    await activatePane(adapter, 's1', null);
    expect(adapter.calls).toEqual([{ id: 's1', cols: undefined, rows: undefined }]);
  });

  it('issues one setActivePane per active-pane change, in order', async () => {
    const adapter = new RecordingAdapter();
    await activatePane(adapter, 's1', { cols: 80, rows: 24 });
    await activatePane(adapter, 's2', { cols: 100, rows: 30 });
    expect(adapter.calls).toEqual([
      { id: 's1', cols: 80, rows: 24 },
      { id: 's2', cols: 100, rows: 30 },
    ]);
  });

  it('waits for an async attach before signaling onAttached', async () => {
    let release: (() => void) | null = null;
    const adapter: PaneActivator = {
      setActivePane: () => new Promise<void>((resolve) => { release = resolve; }),
    };
    const order: string[] = [];
    const done = activatePane(adapter, 's1', null, () => order.push('attached'));

    expect(order).toEqual([]); // still attaching
    release?.();
    await done;
    expect(order).toEqual(['attached']);
  });
});

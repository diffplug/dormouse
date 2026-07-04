/**
 * `RemotePtyAdapter` against a network-free fake {@link RemoteAdapterClient}:
 * directory snapshots become `onPtyList` + `getDirectoryEntries`, `setActivePane`
 * drives the one-attachment-per-session detach→attach dance, `terminal.data`
 * round-trips to `onPtyData`, write/resize reach only the attached pane,
 * `terminal.closed` fires `onPtyExit`, and `dispose` cleans up.
 */

import { describe, expect, it } from 'vitest';
import { toBase64Url, utf8Encode, type DirectoryEntry } from 'server-lib-common';

import { RemotePtyAdapter, type RemoteAdapterClient } from './remote-adapter';
import type { TerminalHandlers } from './pocket-client';
import type { PtyInfo } from '../../lib/platform/types';

interface AttachCall {
  surfaceId: string;
  cols: number;
  rows: number;
  handlers: TerminalHandlers;
  subId: string;
}

class FakeClient implements RemoteAdapterClient {
  snapshotListener: ((entries: DirectoryEntry[]) => void) | null = null;
  readonly directorySubId = 'dir-sub';
  readonly attaches: AttachCall[] = [];
  readonly writes: Array<{ surfaceId: string; bytes: string }> = [];
  readonly resizes: Array<{ surfaceId: string; cols: number; rows: number }> = [];
  readonly detaches: Array<{ surfaceId: string; subId?: string }> = [];
  readonly unsubscribes: string[] = [];
  #attachCounter = 0;

  async watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string> {
    this.snapshotListener = onSnapshot;
    return this.directorySubId;
  }

  async attach(
    surfaceId: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): Promise<{ subId: string; result: { cols: number; rows: number } }> {
    const subId = `attach-${++this.#attachCounter}`;
    this.attaches.push({ surfaceId, cols, rows, handlers, subId });
    return { subId, result: { cols, rows } };
  }

  async write(surfaceId: string, bytes: string): Promise<void> {
    this.writes.push({ surfaceId, bytes });
  }

  async resize(surfaceId: string, cols: number, rows: number): Promise<void> {
    this.resizes.push({ surfaceId, cols, rows });
  }

  async detach(surfaceId: string, subId?: string): Promise<void> {
    this.detaches.push({ surfaceId, subId });
  }

  unsubscribe(subId: string): void {
    this.unsubscribes.push(subId);
  }

  // --- test drivers ---
  pushSnapshot(entries: DirectoryEntry[]): void {
    this.snapshotListener?.(entries);
  }

  lastAttach(): AttachCall {
    const call = this.attaches.at(-1);
    if (!call) throw new Error('no attach recorded');
    return call;
  }
}

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

describe('RemotePtyAdapter directory', () => {
  it('turns a snapshot into onPtyList (alive from exitCode) and getDirectoryEntries', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    const lists: PtyInfo[][] = [];
    adapter.onPtyList(({ ptys }) => lists.push(ptys));

    await adapter.init();
    client.pushSnapshot([entry('s1', { title: 'zsh' }), entry('s2', { exitCode: 0 })]);

    expect(lists).toEqual([
      [
        { id: 's1', alive: true },
        { id: 's2', alive: false, exitCode: 0 },
      ],
    ]);
    expect(adapter.getDirectoryEntries().map((e) => e.surfaceId)).toEqual(['s1', 's2']);
    expect(adapter.getDirectoryEntries()[0].title).toBe('zsh');
    expect(adapter.getPaneEntry('s2')?.exitCode).toBe(0);
  });

  it('notifies subscribeDirectory listeners until they unsubscribe', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    await adapter.init();

    const seen: DirectoryEntry[][] = [];
    const unsub = adapter.subscribeDirectory((entries) => seen.push(entries));
    client.pushSnapshot([entry('s1')]);
    expect(seen).toHaveLength(1);

    unsub();
    client.pushSnapshot([entry('s1'), entry('s2')]);
    expect(seen).toHaveLength(1);
  });

  it('requestInit re-emits the cached list without re-watching', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    await adapter.init();
    client.pushSnapshot([entry('s1')]);

    const lists: PtyInfo[][] = [];
    adapter.onPtyList(({ ptys }) => lists.push(ptys));
    adapter.requestInit();

    expect(lists).toEqual([[{ id: 's1', alive: true }]]);
    expect(client.attaches).toHaveLength(0);
  });
});

describe('RemotePtyAdapter attach / active pane', () => {
  it('attaches on setActivePane and detaches the previous when switching', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);

    await adapter.setActivePane('s1', 80, 24);
    expect(client.attaches).toHaveLength(1);
    expect(client.attaches[0]).toMatchObject({ surfaceId: 's1', cols: 80, rows: 24 });
    expect(adapter.activeSurfaceId).toBe('s1');
    expect(client.detaches).toHaveLength(0);

    await adapter.setActivePane('s2', 100, 30);
    expect(client.detaches).toEqual([{ surfaceId: 's1', subId: 'attach-1' }]);
    expect(client.attaches).toHaveLength(2);
    expect(client.attaches[1]).toMatchObject({ surfaceId: 's2', cols: 100, rows: 30 });
    expect(adapter.activeSurfaceId).toBe('s2');
  });

  it('re-activating the same pane resizes rather than re-attaching', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);

    await adapter.setActivePane('s1', 80, 24);
    await adapter.setActivePane('s1', 120, 40);

    expect(client.attaches).toHaveLength(1);
    expect(client.detaches).toHaveLength(0);
    expect(client.resizes).toEqual([{ surfaceId: 's1', cols: 120, rows: 40 }]);
  });

  it('decodes terminal.data (base64url utf8) into an onPtyData string', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    const data: Array<{ id: string; data: string }> = [];
    adapter.onPtyData((d) => data.push(d));

    await adapter.setActivePane('s1', 80, 24);
    client.lastAttach().handlers.onData(toBase64Url(utf8Encode('héllo ▲')));

    expect(data).toEqual([{ id: 's1', data: 'héllo ▲' }]);
  });

  it('routes write and resize only to the attached pane', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    await adapter.setActivePane('s1', 80, 24);

    adapter.writePty('s1', 'ls\r');
    adapter.writePty('s2', 'ignored'); // not attached → dropped
    expect(client.writes).toEqual([{ surfaceId: 's1', bytes: toBase64Url(utf8Encode('ls\r')) }]);

    adapter.resizePty('s1', 90, 20);
    adapter.resizePty('s2', 10, 10); // not attached → dropped
    expect(client.resizes).toEqual([{ surfaceId: 's1', cols: 90, rows: 20 }]);
  });

  it('spawnPty / killPty are no-ops (panes are Host-owned)', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    adapter.spawnPty();
    adapter.killPty();
    expect(client.attaches).toHaveLength(0);
    expect(client.detaches).toHaveLength(0);
  });

  it('terminal.closed fires onPtyExit and clears the attachment', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    const exits: Array<{ id: string; exitCode: number }> = [];
    adapter.onPtyExit((d) => exits.push(d));

    await adapter.setActivePane('s1', 80, 24);
    client.lastAttach().handlers.onClosed?.(3);

    expect(exits).toEqual([{ id: 's1', exitCode: 3 }]);
    expect(adapter.activeSurfaceId).toBeNull();

    // Once closed the pane is no longer attached, so writes are dropped.
    adapter.writePty('s1', 'x');
    expect(client.writes).toHaveLength(0);
  });

  it('terminal.closed with an omitted exitCode surfaces the unknown-exit sentinel (-1), not 0', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    const exits: Array<{ id: string; exitCode: number }> = [];
    adapter.onPtyExit((d) => exits.push(d));

    await adapter.setActivePane('s1', 80, 24);
    // TerminalClosedEvent.exitCode is optional on the wire; a signal-only /
    // killed / non-selfhost close forwards no code. It must not read as 0.
    client.lastAttach().handlers.onClosed?.(undefined);

    expect(exits).toEqual([{ id: 's1', exitCode: -1 }]);
    expect(adapter.activeSurfaceId).toBeNull();
  });

  it('terminal.closed with a present exitCode passes it through unchanged (incl. 0)', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    const exits: Array<{ id: string; exitCode: number }> = [];
    adapter.onPtyExit((d) => exits.push(d));

    await adapter.setActivePane('s1', 80, 24);
    client.lastAttach().handlers.onClosed?.(0);

    expect(exits).toEqual([{ id: 's1', exitCode: 0 }]);
  });
});

describe('RemotePtyAdapter dispose', () => {
  it('detaches the live surface and unsubscribes the directory', async () => {
    const client = new FakeClient();
    const adapter = new RemotePtyAdapter(client);
    await adapter.init();
    await adapter.setActivePane('s1', 80, 24);

    await adapter.dispose();

    expect(client.unsubscribes).toContain('dir-sub');
    expect(client.detaches).toContainEqual({ surfaceId: 's1', subId: 'attach-1' });
    expect(adapter.activeSurfaceId).toBeNull();
  });
});

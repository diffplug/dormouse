import { describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
import { WatchedCommandHost } from './watched-command-host';

describe('WatchedCommandHost', () => {
  it('keeps the first renderer seed and merges later renderer mutations', () => {
    const manager = new AlertManager();
    const host = new WatchedCommandHost(manager);
    const snapshots: string[][] = [];
    host.subscribe((names) => snapshots.push(names));

    host.initialize(['claude']);
    // A second webview may have loaded an older renderer-local snapshot. Its
    // startup seed must not replace the already-authoritative host state.
    host.initialize([]);
    host.setCommandWatched('npm', true);

    expect(manager.getWatchedCommands()).toEqual(['claude', 'npm']);
    expect(snapshots).toEqual([
      ['claude'],
      ['claude'],
      ['claude', 'npm'],
    ]);
  });

  it('broadcasts removals without dropping unrelated rules', () => {
    const manager = new AlertManager();
    const host = new WatchedCommandHost(manager);
    const listener = vi.fn();
    host.subscribe(listener);

    host.initialize(['claude', 'npm']);
    host.setCommandWatched('claude', false);

    expect(manager.getWatchedCommands()).toEqual(['npm']);
    expect(listener).toHaveBeenLastCalledWith(['npm']);
  });
});

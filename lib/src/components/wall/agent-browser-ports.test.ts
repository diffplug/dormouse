import { describe, expect, it, vi } from 'vitest';
import {
  getDevServerResolution,
  getWantedDevServerPorts,
  releaseDevServerPort,
  requestDevServerPort,
  setDevServerResolution,
  subscribeDevServerRescan,
  subscribeDevServerResolutions,
  subscribeWantedDevServerPorts,
  triggerDevServerRescan,
} from './agent-browser-ports';

describe('dev-server port store', () => {
  it('reference-counts interest and notifies on the first/last watcher', () => {
    const notify = vi.fn();
    const unsubscribe = subscribeWantedDevServerPorts(notify);

    requestDevServerPort(5173);
    expect(getWantedDevServerPorts()).toContain(5173);
    expect(notify).toHaveBeenCalledTimes(1);

    // A second watcher on the same port is not a new "wanted" edge.
    requestDevServerPort(5173);
    expect(notify).toHaveBeenCalledTimes(1);

    releaseDevServerPort(5173);
    expect(getWantedDevServerPorts()).toContain(5173);
    expect(notify).toHaveBeenCalledTimes(1);

    releaseDevServerPort(5173);
    expect(getWantedDevServerPorts()).not.toContain(5173);
    expect(notify).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('publishes resolutions and dedupes equal matches', () => {
    const notify = vi.fn();
    const unsubscribe = subscribeDevServerResolutions(notify);

    setDevServerResolution(4000, { paneId: 'pane-a', label: 'pnpm dev' });
    expect(getDevServerResolution(4000)).toEqual({ paneId: 'pane-a', label: 'pnpm dev' });
    expect(notify).toHaveBeenCalledTimes(1);

    // An equal match must not re-notify (keeps useSyncExternalStore stable).
    setDevServerResolution(4000, { paneId: 'pane-a', label: 'pnpm dev' });
    expect(notify).toHaveBeenCalledTimes(1);

    setDevServerResolution(4000, null);
    expect(getDevServerResolution(4000)).toBeNull();
    expect(notify).toHaveBeenCalledTimes(2);

    unsubscribe();
  });

  it('notifies rescan subscribers without touching resolutions', () => {
    requestDevServerPort(7000);
    setDevServerResolution(7000, { paneId: 'pane-r', label: 'pnpm dev' });

    const notify = vi.fn();
    const unsubscribe = subscribeDevServerRescan(notify);

    triggerDevServerRescan();
    expect(notify).toHaveBeenCalledTimes(1);
    // The signal is optimistic: the current match stays put until a rescan
    // actually overwrites it.
    expect(getDevServerResolution(7000)).toEqual({ paneId: 'pane-r', label: 'pnpm dev' });

    unsubscribe();
    triggerDevServerRescan();
    expect(notify).toHaveBeenCalledTimes(1);

    releaseDevServerPort(7000);
  });

  it('keeps the cached resolution when the last watcher releases the port', () => {
    requestDevServerPort(9999);
    setDevServerResolution(9999, { paneId: 'pane-z', label: 'vite' });
    expect(getDevServerResolution(9999)).not.toBeNull();

    // Releasing drops the "wanted" interest but KEEPS the cached resolution.
    // Release is also what React StrictMode's mount→cleanup→mount runs on every
    // header mount; clearing here would blank the chip until the next Wall scan.
    // The Wall owns clearing stale resolutions (it re-validates re-wanted ports).
    releaseDevServerPort(9999);
    expect(getWantedDevServerPorts()).not.toContain(9999);
    expect(getDevServerResolution(9999)).toEqual({ paneId: 'pane-z', label: 'vite' });
  });
});

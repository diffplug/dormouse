import { describe, expect, it, vi } from 'vitest';
import {
  getDevServerResolution,
  getWantedDevServerPorts,
  releaseDevServerPort,
  requestDevServerPort,
  setDevServerResolution,
  subscribeDevServerResolutions,
  subscribeWantedDevServerPorts,
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

  it('clears a resolution once the last watcher releases the port', () => {
    requestDevServerPort(9999);
    setDevServerResolution(9999, { paneId: 'pane-z', label: 'vite' });
    expect(getDevServerResolution(9999)).not.toBeNull();

    releaseDevServerPort(9999);
    expect(getDevServerResolution(9999)).toBeNull();
    expect(getWantedDevServerPorts()).not.toContain(9999);
  });
});

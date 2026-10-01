import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearWorkspaceSurfaces,
  getWorkspaceSurfacesSnapshot,
  resetWorkspaceSurfaces,
  setWorkspaceSurfaces,
  subscribeToWorkspaceSurfaces,
} from './workspace-surfaces';

beforeEach(() => {
  resetWorkspaceSurfaces();
});

describe('workspace membership store', () => {
  it('keeps the snapshot reference stable when the ids are element-wise equal', () => {
    setWorkspaceSurfaces('ws-1', ['a', 'b']);
    const first = getWorkspaceSurfacesSnapshot();
    setWorkspaceSurfaces('ws-1', ['a', 'b']);
    expect(getWorkspaceSurfacesSnapshot()).toBe(first);
    setWorkspaceSurfaces('ws-1', ['a', 'c']);
    expect(getWorkspaceSurfacesSnapshot()).not.toBe(first);
  });

  it('notifies only on a real change, and on clear', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToWorkspaceSurfaces(listener);
    setWorkspaceSurfaces('ws-1', ['a']);
    setWorkspaceSurfaces('ws-1', ['a']);
    expect(listener).toHaveBeenCalledTimes(1);
    clearWorkspaceSurfaces('ws-1');
    expect(listener).toHaveBeenCalledTimes(2);
    clearWorkspaceSurfaces('ws-1');
    expect(listener).toHaveBeenCalledTimes(2);
    unsubscribe();
    setWorkspaceSurfaces('ws-1', ['b']);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('copies the published array so a later mutation by the caller cannot leak in', () => {
    const ids = ['a'];
    setWorkspaceSurfaces('ws-1', ids);
    ids.push('b');
    expect(getWorkspaceSurfacesSnapshot().get('ws-1')).toEqual(['a']);
  });
});

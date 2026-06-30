import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isWorkspacesEnabled, setWorkspacesEnabled, WORKSPACES_FLAG_KEY } from './feature-flags';

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  return store;
}

describe('feature-flags: workspaces', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default (dormant)', () => {
    stubLocalStorage();
    expect(isWorkspacesEnabled()).toBe(false);
  });

  it('round-trips via localStorage', () => {
    const store = stubLocalStorage();
    setWorkspacesEnabled(true);
    expect(store.get(WORKSPACES_FLAG_KEY)).toBe('true');
    expect(isWorkspacesEnabled()).toBe(true);
    setWorkspacesEnabled(false);
    expect(store.has(WORKSPACES_FLAG_KEY)).toBe(false);
    expect(isWorkspacesEnabled()).toBe(false);
  });

  describe('without localStorage', () => {
    beforeEach(() => vi.stubGlobal('localStorage', undefined));
    it('treats the flag as disabled and never throws', () => {
      expect(isWorkspacesEnabled()).toBe(false);
      expect(() => setWorkspacesEnabled(true)).not.toThrow();
    });
  });
});

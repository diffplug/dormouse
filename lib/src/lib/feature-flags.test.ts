import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AB_DEBUG_LOGS_FLAG_KEY, isAbDebugLogsEnabled } from './feature-flags';

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  return store;
}

describe('feature-flags: agent-browser debug logs', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('is off by default', () => {
    stubLocalStorage();
    expect(isAbDebugLogsEnabled()).toBe(false);
  });

  it('reads the flag out of localStorage', () => {
    const store = stubLocalStorage();
    store.set(AB_DEBUG_LOGS_FLAG_KEY, 'true');
    expect(isAbDebugLogsEnabled()).toBe(true);
    store.set(AB_DEBUG_LOGS_FLAG_KEY, 'yes');
    expect(isAbDebugLogsEnabled()).toBe(false);
  });

  describe('without localStorage', () => {
    beforeEach(() => vi.stubGlobal('localStorage', undefined));
    it('treats the flag as disabled and never throws', () => {
      expect(isAbDebugLogsEnabled()).toBe(false);
    });
  });

  describe('with a throwing localStorage', () => {
    beforeEach(() => vi.stubGlobal('localStorage', {
      get getItem(): never { throw new Error('blocked by site settings'); },
    }));
    it('treats the flag as disabled and never throws', () => {
      expect(isAbDebugLogsEnabled()).toBe(false);
    });
  });
});

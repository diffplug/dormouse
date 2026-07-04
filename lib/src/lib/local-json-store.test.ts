import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadJson, saveJson } from './local-json-store';

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  return store;
}

interface Widget {
  id: string;
}

function isWidget(value: unknown): value is Widget {
  return !!value && typeof value === 'object' && typeof (value as Widget).id === 'string';
}

describe('local-json-store', () => {
  afterEach(() => vi.unstubAllGlobals());

  describe('loadJson', () => {
    it('round-trips a stored value', () => {
      const store = stubLocalStorage();
      store.set('k', JSON.stringify({ id: 'w1' }));
      expect(loadJson<Widget, null>('k', null, isWidget)).toEqual({ id: 'w1' });
    });

    it('returns the fallback for a missing key', () => {
      stubLocalStorage();
      expect(loadJson<Widget, null>('missing', null, isWidget)).toBeNull();
      expect(loadJson<number[]>('missing', [])).toEqual([]);
    });

    it('returns the fallback for malformed JSON', () => {
      const store = stubLocalStorage();
      store.set('k', 'not json');
      expect(loadJson<Widget, null>('k', null, isWidget)).toBeNull();
      expect(loadJson<unknown[]>('k', [], Array.isArray)).toEqual([]);
    });

    it('returns the fallback when the guard rejects the parsed value', () => {
      const store = stubLocalStorage();
      store.set('k', JSON.stringify({ notId: 42 }));
      expect(loadJson<Widget, null>('k', null, isWidget)).toBeNull();
    });

    it('returns the parsed value unvalidated when no guard is given', () => {
      const store = stubLocalStorage();
      store.set('k', JSON.stringify({ id: 'w1' }));
      expect(loadJson<Widget, null>('k', null)).toEqual({ id: 'w1' });
    });

    it('returns the fallback when localStorage is absent', () => {
      vi.stubGlobal('localStorage', undefined);
      expect(loadJson<Widget, null>('k', null, isWidget)).toBeNull();
      expect(loadJson<unknown[]>('k', [], Array.isArray)).toEqual([]);
    });
  });

  describe('saveJson', () => {
    it('JSON-stringifies and writes the value', () => {
      const store = stubLocalStorage();
      saveJson('k', { id: 'w1' });
      expect(store.get('k')).toBe(JSON.stringify({ id: 'w1' }));
    });

    it('does not throw when localStorage is absent', () => {
      vi.stubGlobal('localStorage', undefined);
      expect(() => saveJson('k', { id: 'w1' })).not.toThrow();
    });

    it('swallows a write failure (e.g. quota exceeded)', () => {
      vi.stubGlobal('localStorage', {
        getItem: () => null,
        setItem: () => {
          throw new DOMException('quota', 'QuotaExceededError');
        },
        removeItem: () => {},
      });
      expect(() => saveJson('k', { id: 'w1' })).not.toThrow();
    });
  });
});

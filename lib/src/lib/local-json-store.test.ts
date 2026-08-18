import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadJson, removeJson, saveJson, setJsonStoreBackend } from './local-json-store';

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
  describe('removeJson', () => {
    it('deletes the stored value', () => {
      const store = stubLocalStorage();
      saveJson('k', { id: 'w1' });
      removeJson('k');
      expect(store.has('k')).toBe(false);
      expect(loadJson<Widget, null>('k', null, isWidget)).toBeNull();
    });

    it('does not throw when localStorage is absent', () => {
      vi.stubGlobal('localStorage', undefined);
      expect(() => removeJson('k')).not.toThrow();
    });
  });

  describe('prefix-claimed backends', () => {
    function fakeBackend() {
      const map = new Map<string, string>();
      return {
        map,
        getItem: (key: string) => map.get(key) ?? null,
        setItem: (key: string, value: string) => void map.set(key, value),
        removeItem: (key: string) => void map.delete(key),
      };
    }

    afterEach(() => {
      setJsonStoreBackend('a.', null);
      setJsonStoreBackend('a.b.', null);
    });

    it('routes a claimed prefix to its backend and leaves other keys on localStorage', () => {
      const local = stubLocalStorage();
      const backend = fakeBackend();
      setJsonStoreBackend('a.', backend);

      saveJson('a.one', { id: 'w1' });
      saveJson('other.two', { id: 'w2' });

      expect(backend.map.has('a.one')).toBe(true);
      // The unrelated key must not be swept into the claimed backend — this is
      // what keeps alert settings and watched commands on their own storage.
      expect(backend.map.has('other.two')).toBe(false);
      expect(local.get('other.two')).toBe(JSON.stringify({ id: 'w2' }));
      expect(local.has('a.one')).toBe(false);

      expect(loadJson<Widget, null>('a.one', null, isWidget)).toEqual({ id: 'w1' });
      expect(loadJson<Widget, null>('other.two', null, isWidget)).toEqual({ id: 'w2' });
    });

    it('prefers the longest matching prefix', () => {
      stubLocalStorage();
      const outer = fakeBackend();
      const inner = fakeBackend();
      setJsonStoreBackend('a.', outer);
      setJsonStoreBackend('a.b.', inner);

      saveJson('a.b.key', 1);
      saveJson('a.key', 2);

      expect(inner.map.has('a.b.key')).toBe(true);
      expect(outer.map.has('a.b.key')).toBe(false);
      expect(outer.map.has('a.key')).toBe(true);
    });

    it('releases a claim back to localStorage', () => {
      const local = stubLocalStorage();
      const backend = fakeBackend();
      setJsonStoreBackend('a.', backend);
      setJsonStoreBackend('a.', null);

      saveJson('a.one', { id: 'w1' });

      expect(backend.map.size).toBe(0);
      expect(local.get('a.one')).toBe(JSON.stringify({ id: 'w1' }));
    });

    it('removeJson deletes through the claimed backend', () => {
      stubLocalStorage();
      const backend = fakeBackend();
      setJsonStoreBackend('a.', backend);
      saveJson('a.one', { id: 'w1' });

      removeJson('a.one');

      expect(backend.map.has('a.one')).toBe(false);
    });

    it('a throwing backend never propagates', () => {
      stubLocalStorage();
      setJsonStoreBackend('a.', {
        getItem: () => {
          throw new Error('nope');
        },
        setItem: () => {
          throw new Error('nope');
        },
        removeItem: () => {
          throw new Error('nope');
        },
      });

      expect(() => saveJson('a.one', 1)).not.toThrow();
      expect(loadJson('a.one', 'fallback')).toBe('fallback');
      expect(() => removeJson('a.one')).not.toThrow();
    });
  });
});

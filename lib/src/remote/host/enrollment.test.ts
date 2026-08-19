import { afterEach, describe, expect, it, vi } from 'vitest';
import { clearEnrollment, getEnrollment, performEnrollment } from './enrollment';
import { ENROLLMENT_KEY } from './store';

function stubLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  });
  return store;
}

describe('remote-host enrollment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts to /api/host/enroll, normalizes the url, and persists nothing', async () => {
    const store = stubLocalStorage();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          hostId: 'host-abc',
          hostToken: 'tok-xyz',
          origin: 'https://dormouse.example',
          rpId: 'dormouse.example',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    // Trailing slash should be stripped before appending the route.
    const enrollment = await performEnrollment('https://dormouse.example/', 'hunter2', 'My Laptop');

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dormouse.example/api/host/enroll',
      expect.objectContaining({ method: 'POST' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ password: 'hunter2', label: 'My Laptop' });

    expect(enrollment).toEqual({
      serverUrl: 'https://dormouse.example',
      hostId: 'host-abc',
      hostToken: 'tok-xyz',
      origin: 'https://dormouse.example',
      rpId: 'dormouse.example',
    });
    // The service that asked decides where the credentials live; the exchange
    // itself writes nowhere.
    expect(store.size).toBe(0);
  });

  it('throws on a non-ok response', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad password', { status: 401 })));
    await expect(performEnrollment('https://dormouse.example', 'wrong', 'x')).rejects.toThrow(/401/);
  });

  it('clears and rejects malformed persisted enrollment', () => {
    // What a webview that enrolled before the service existed still holds, and
    // hands over once (`activation.ts` → adoption).
    const store = stubLocalStorage();
    expect(getEnrollment()).toBeNull();

    store.set(ENROLLMENT_KEY, JSON.stringify({ serverUrl: 'x' })); // missing fields
    expect(getEnrollment()).toBeNull();

    store.set(
      ENROLLMENT_KEY,
      JSON.stringify({
        serverUrl: 's',
        hostId: 'h',
        hostToken: 't',
        origin: 'o',
        rpId: 'r',
      }),
    );
    expect(getEnrollment()).not.toBeNull();

    clearEnrollment();
    expect(store.has(ENROLLMENT_KEY)).toBe(false);
    expect(getEnrollment()).toBeNull();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ENROLLMENT_KEY,
  clearEnrollment,
  enrollHost,
  getEnrollment,
} from './enrollment';

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

  it('posts to /api/host/enroll, normalizes the url, and persists', async () => {
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
    const enrollment = await enrollHost('https://dormouse.example/', 'hunter2', 'My Laptop');

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
    expect(JSON.parse(store.get(ENROLLMENT_KEY)!)).toEqual(enrollment);
    expect(getEnrollment()).toEqual(enrollment);
  });

  it('throws on a non-ok response', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad password', { status: 401 })));
    await expect(enrollHost('https://dormouse.example', 'wrong', 'x')).rejects.toThrow(/401/);
  });

  it('clears and rejects malformed persisted enrollment', () => {
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

import { afterEach, describe, expect, it, vi } from 'vitest';
import { fromBase64Url, mintNoiseStaticKeyPair, toBase64Url } from 'server-lib-common';
import { clearEnrollment, getEnrollment, isEnrollment, performEnrollment } from './enrollment';
import { ENROLLMENT_KEY } from './store';

// Only the minter is faked, and only where a test asks for it; everything else
// in the package stays real so the guards under test are the shipped ones.
vi.mock('server-lib-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('server-lib-common')>();
  return { ...actual, mintNoiseStaticKeyPair: vi.fn(actual.mintNoiseStaticKeyPair) };
});

/** A server answering a well-formed enrollment; the body is what varies. */
function enrollResponder(): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
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
}

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
    const enrollment = await performEnrollment(
      'https://dormouse.example/',
      { password: 'hunter2' },
      'My Laptop',
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dormouse.example/api/host/enroll',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ password: 'hunter2', label: 'My Laptop' });

    expect(enrollment).toEqual({
      serverUrl: 'https://dormouse.example',
      hostId: 'host-abc',
      hostToken: 'tok-xyz',
      origin: 'https://dormouse.example',
      rpId: 'dormouse.example',
      // Minted locally, after the answer above (see the Noise-static test).
      noiseStaticPrivateKey: expect.any(String),
      noiseStaticPublicKey: expect.any(String),
    });
    // The service that asked decides where the credentials live; the exchange
    // itself writes nowhere.
    expect(store.size).toBe(0);
  });

  it('mints a Noise static the server never sees', async () => {
    // The Host's permanent end-to-end identity is generated on this machine
    // and persisted with the enrollment; the enroll request body is unchanged
    // (docs/specs/remote-security-model.md → E2E identities and presence).
    stubLocalStorage();
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

    const enrollment = await performEnrollment(
      'https://dormouse.example',
      { password: 'hunter2' },
      'My Laptop',
    );

    expect(enrollment.noiseStaticPublicKey).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(fromBase64Url(enrollment.noiseStaticPublicKey!)).toHaveLength(32);
    // A canonical X25519 PKCS#8.
    expect(fromBase64Url(enrollment.noiseStaticPrivateKey!)).toHaveLength(48);
    // Round-trips through the guard every read runs.
    expect(isEnrollment(enrollment)).toBe(true);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string) as Record<
      string,
      unknown
    >;
    expect(body).toEqual({ password: 'hunter2', label: 'My Laptop' });
  });

  it('still enrolls when the runtime mints a static this build cannot persist', async () => {
    // Minting is best-effort: a PKCS#8 outside what `isEnrollment` accepts must
    // cost the Host its E2E identity, not its enrollment.
    stubLocalStorage();
    vi.mocked(mintNoiseStaticKeyPair).mockResolvedValueOnce({
      privateKeyPkcs8: toBase64Url(new Uint8Array(256)),
      publicKey: toBase64Url(new Uint8Array(32)),
    });
    vi.stubGlobal('fetch', enrollResponder());

    const enrollment = await performEnrollment(
      'https://dormouse.example',
      { password: 'hunter2' },
      'My Laptop',
    );

    expect(enrollment.hostId).toBe('host-abc');
    expect(enrollment.noiseStaticPrivateKey).toBeUndefined();
    expect(enrollment.noiseStaticPublicKey).toBeUndefined();
  });

  it('sends the installer’s one-time token in place of the password', async () => {
    // `HostEnrollRequest` is a union of exactly one credential, and the server
    // answers 400 for both or neither — so the body must carry the token alone.
    stubLocalStorage();
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

    await performEnrollment('https://dormouse.example', { enrollToken: 'f'.repeat(64) }, 'My Laptop');

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ enrollToken: 'f'.repeat(64), label: 'My Laptop' });
    expect(body).not.toHaveProperty('password');
  });

  it('gives up on a relay that accepts the connection and never answers', async () => {
    // This exchange runs on the Host service's lifecycle chain, where every
    // start/stop command queues behind it, so a black-holed relay must not be
    // allowed to wedge them for the platform's default socket timeout.
    stubLocalStorage();
    const controller = new AbortController();
    const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValue(controller.signal);
    let seen: AbortSignal | undefined;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        seen = init.signal ?? undefined;
        return new Promise<Response>((_resolve, reject) => {
          init.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }),
    );

    const pending = performEnrollment('https://dormouse.example', { password: 'hunter2' }, 'x');
    // Below the webview's own 15 s command budget, so the console that asked
    // sees the real error rather than a bare timeout.
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(seen).toBe(controller.signal);

    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    timeout.mockRestore();
  });

  it('throws on a non-ok response', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('bad password', { status: 401 })));
    await expect(performEnrollment('https://dormouse.example', { password: 'wrong' }, 'x')).rejects.toThrow(/401/);
  });

  it('refuses a 200 whose body is not an enrollment', async () => {
    // A version skew or a proxy that rewrote the body. Minting from it would
    // hand the Host an `undefined` in the `ConnectionPolicy` it authenticates
    // passkeys against, and persist a record that `isEnrollment` rejects on the
    // next read — the machine un-enrolls itself at the next launch with nothing
    // in the log to explain it. Name the missing fields instead.
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ hostId: 'host-abc', hostToken: 'tok-xyz' }), // no origin/rpId
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(performEnrollment('https://dormouse.example', { password: 'hunter2' }, 'x')).rejects.toThrow(
      /missing or invalid: origin, rpId/,
    );
  });

  it('refuses a 200 whose fields are the wrong type', async () => {
    // `hostId: null` type-checks as `HostEnrollResponse` only because the body
    // is cast, not parsed; the guard is what actually rejects it. It is present
    // in the body, so the error says "missing or invalid" rather than "missing".
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ hostId: null, hostToken: 'tok-xyz', origin: 'o', rpId: 'r' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(performEnrollment('https://dormouse.example', { password: 'hunter2' }, 'x')).rejects.toThrow(
      /missing or invalid: hostId/,
    );
  });

  it('refuses a 200 that is not JSON at all', async () => {
    // A captive portal or a proxy error page served with a 200.
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>not your server</html>', { status: 200 })),
    );

    await expect(performEnrollment('https://dormouse.example', { password: 'hunter2' }, 'x')).rejects.toThrow(
      /did not answer JSON/,
    );
  });

  it('takes both halves of the Noise static or neither, never one', () => {
    // A record written before the field existed must keep loading; one half
    // alone is a truncated write or a hand-edited file, and a Host that
    // believed it had an identity it cannot use is worse than one that knows
    // it has none.
    const base = {
      serverUrl: 's',
      hostId: 'h',
      hostToken: 't',
      origin: 'o',
      rpId: 'r',
    };
    const noiseStaticPublicKey = toBase64Url(new Uint8Array(32));
    const noiseStaticPrivateKey = toBase64Url(new Uint8Array(48));

    expect(isEnrollment(base)).toBe(true);
    expect(isEnrollment({ ...base, noiseStaticPublicKey, noiseStaticPrivateKey })).toBe(true);
    expect(isEnrollment({ ...base, noiseStaticPublicKey })).toBe(false);
    expect(isEnrollment({ ...base, noiseStaticPrivateKey })).toBe(false);
    // Well-formed base64url of the right decoded length: the value goes
    // straight to `importKey`, from a file writable by anything running as
    // this user.
    expect(
      isEnrollment({ ...base, noiseStaticPrivateKey, noiseStaticPublicKey: 'not base64url!!!!!!!!!!!!!!!!!!!!!!!!!!!!!!' }),
    ).toBe(false);
    expect(
      isEnrollment({ ...base, noiseStaticPrivateKey, noiseStaticPublicKey: toBase64Url(new Uint8Array(31)) }),
    ).toBe(false);
    expect(
      isEnrollment({ ...base, noiseStaticPublicKey, noiseStaticPrivateKey: toBase64Url(new Uint8Array(16)) }),
    ).toBe(false);
    expect(
      isEnrollment({ ...base, noiseStaticPublicKey, noiseStaticPrivateKey: toBase64Url(new Uint8Array(256)) }),
    ).toBe(false);
    expect(isEnrollment({ ...base, noiseStaticPublicKey, noiseStaticPrivateKey: 42 })).toBe(false);
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

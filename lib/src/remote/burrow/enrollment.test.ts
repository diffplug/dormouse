import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  BAD_PASSWORD_ERROR,
  NOT_ENTITLED_ERROR,
  ORIGIN_MISMATCH_ERROR,
  RELAY_BEARER_LENGTH,
  UNAUTHORIZED_ERROR,
  fromBase64Url,
  mintNoiseStaticKeyPair,
  toBase64Url,
} from 'remote-lib-common';
import { TEST_SETUP_PASSWORD } from '../test-setup-password';
import {
  beginHostedEnrollment,
  isEnrollment,
  performEnrollment,
  pollHostedEnrollment,
  type EnrollmentStatic,
} from './enrollment';

// A real `burrowId`: base64url of 16 bytes, the one shape `isEnrollment`
// accepts, because it is also the routing id every `e2e` envelope carries.
const BURROW_ID = 'S6kyjjqOS7mw3l8ye89U3g';

/** The fields every stored enrollment carries beside what the Relay answered. */
const LOCAL = {
  label: 'Laptop',
  noiseStaticPublicKey: toBase64Url(new Uint8Array(32)),
  noiseStaticPrivateKey: toBase64Url(new Uint8Array(48)),
};

// Only the minter is faked, and only where a test asks for it; everything else
// in the package stays real so the guards under test are the shipped ones.
vi.mock('remote-lib-common', async (importOriginal) => {
  const actual = await importOriginal<typeof import('remote-lib-common')>();
  return { ...actual, mintNoiseStaticKeyPair: vi.fn(actual.mintNoiseStaticKeyPair) };
});

/** A Relay answering a well-formed enrollment; the body is what varies. */
function enrollResponder(): ReturnType<typeof vi.fn> {
  return vi.fn(async () =>
    new Response(
      JSON.stringify({
        burrowId: BURROW_ID,
        burrowToken: 'tok-xyz',
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

describe('burrow enrollment', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('posts the credential and the baked origin to /api/burrow/enroll, and persists nothing', async () => {
    const store = stubLocalStorage();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          burrowId: BURROW_ID,
          burrowToken: 'tok-xyz',
          origin: 'https://dormouse.example',
          rpId: 'dormouse.example',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const enrollment = await performEnrollment(
      'https://dormouse.example',
      { password: TEST_SETUP_PASSWORD },
      'My Laptop',
      fetch,
    );

    expect(fetchMock).toHaveBeenCalledWith(
      'https://dormouse.example/api/burrow/enroll',
      expect.objectContaining({ method: 'POST', redirect: 'error' }),
    );
    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ password: TEST_SETUP_PASSWORD, origin: 'https://dormouse.example' });

    expect(enrollment).toEqual({
      relayUrl: 'https://dormouse.example',
      burrowId: BURROW_ID,
      burrowToken: 'tok-xyz',
      origin: 'https://dormouse.example',
      rpId: 'dormouse.example',
      // Kept from the caller's own argument: the request never carries one,
      // and this is what the machine calls itself inside an encrypted outcome.
      label: 'My Laptop',
      // Minted locally, before the request and never in it (see below).
      noiseStaticPrivateKey: expect.any(String),
      noiseStaticPublicKey: expect.any(String),
    });
    // The service that asked decides where the credentials live; the exchange
    // itself writes nowhere.
    expect(store.size).toBe(0);
  });

  it('mints a Noise static the Relay never sees', async () => {
    // The Burrow's permanent end-to-end identity is generated on this machine
    // and persisted with the enrollment; the enroll request body is unchanged
    // (docs/specs/remote-security-model.md → Burrow identity).
    stubLocalStorage();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          burrowId: BURROW_ID,
          burrowToken: 'tok-xyz',
          origin: 'https://dormouse.example',
          rpId: 'dormouse.example',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    const enrollment = await performEnrollment(
      'https://dormouse.example',
      { password: TEST_SETUP_PASSWORD },
      'My Laptop',
      fetch,
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
    expect(body).toEqual({ password: TEST_SETUP_PASSWORD, origin: 'https://dormouse.example' });
  });

  it('refuses to enroll when the runtime cannot mint the static it needs', async () => {
    // The probe gate's Burrow half. The end-to-end protocol is mandatory and the
    // static is this Burrow's identity in it, so enrolling without one would
    // persist a `burrowToken` for a machine that can never answer a pairing or a
    // connection — a Burrow that looks connected and does nothing.
    const store = stubLocalStorage();
    vi.stubGlobal('fetch', enrollResponder());

    // A runtime with no X25519 at all.
    vi.mocked(mintNoiseStaticKeyPair).mockRejectedValueOnce(new Error('unsupported curve'));
    await expect(
      performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'My Laptop', fetch),
    ).rejects.toThrow(/cannot generate the X25519 key/);

    // And one whose PKCS#8 falls outside what `isEnrollment` accepts: caught
    // here, naming the key, rather than at the next read naming nothing.
    vi.mocked(mintNoiseStaticKeyPair).mockResolvedValueOnce({
      privateKeyPkcs8: toBase64Url(new Uint8Array(256)),
      publicKey: toBase64Url(new Uint8Array(32)),
    });
    await expect(
      performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'My Laptop', fetch),
    ).rejects.toThrow(/not a shape this build persists/);

    expect(store.size).toBe(0);
  });

  it('sends the installer’s one-time token in place of the password', async () => {
    // `BurrowEnrollRequest` is a union of exactly one credential, and the Relay
    // answers 400 for both or neither — so the body must carry the token alone.
    stubLocalStorage();
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          burrowId: BURROW_ID,
          burrowToken: 'tok-xyz',
          origin: 'https://dormouse.example',
          rpId: 'dormouse.example',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    );
    vi.stubGlobal('fetch', fetchMock);

    await performEnrollment('https://dormouse.example', { enrollToken: 'f'.repeat(64) }, 'My Laptop', fetch);

    const body = JSON.parse((fetchMock.mock.calls[0]![1] as RequestInit).body as string);
    expect(body).toEqual({ enrollToken: 'f'.repeat(64), origin: 'https://dormouse.example' });
    expect(body).not.toHaveProperty('password');
  });

  it('mints the Noise static before the exchange, so a failure costs nothing', async () => {
    stubLocalStorage();
    const fetchMock = enrollResponder();
    vi.stubGlobal('fetch', fetchMock);
    vi.mocked(mintNoiseStaticKeyPair).mockRejectedValueOnce(new Error('no X25519 here'));

    await expect(
      performEnrollment('https://dormouse.example', { enrollToken: 'one-time' }, 'My Laptop', fetch),
    ).rejects.toThrow(/cannot generate the X25519 key/);
    // A successful POST appends a `burrows.json` row and spends the installer's
    // single-use token, neither of which this side can undo — so a runtime that
    // cannot mint must fail while the Relay still has nothing to forget.
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('gives up on a relay that accepts the connection and never answers', async () => {
    // This exchange runs on the Burrow service's lifecycle chain, where every
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

    const pending = performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch);
    // Awaited rather than asserted synchronously: the X25519 mint runs before
    // the exchange (see "mints the Noise static before the exchange"), so the
    // request is one WebCrypto round trip away rather than in this tick.
    await vi.waitFor(() => expect(seen).toBeDefined());
    // Below the webview's own 15 s command budget, so the console that asked
    // sees the real error rather than a bare timeout.
    expect(timeout).toHaveBeenCalledWith(10_000);
    expect(seen).toBe(controller.signal);

    controller.abort();
    await expect(pending).rejects.toThrow(/abort/i);
    timeout.mockRestore();
  });

  /** A 401 answers the same status for two credentials with different recoveries. */
  const refused = (error: string) =>
    vi.fn(async () => new Response(JSON.stringify({ error }), { status: 401 }));

  it('names the credential the Relay says it refused', async () => {
    stubLocalStorage();
    vi.stubGlobal('fetch', refused(BAD_PASSWORD_ERROR));
    await expect(
      performEnrollment('https://dormouse.example', { password: 'wrong' }, 'x', fetch),
    ).rejects.toThrow('The Relay did not accept that setup password.');

    vi.stubGlobal('fetch', refused(UNAUTHORIZED_ERROR));
    await expect(
      performEnrollment('https://dormouse.example', { enrollToken: 'spent' }, 'x', fetch),
    ).rejects.toThrow(/enrollment offer is no longer valid/);
  });

  it('names both origins when the Relay is served from another', async () => {
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(JSON.stringify({ error: ORIGIN_MISMATCH_ERROR, origin: 'https://relay.example' }), {
          status: 409,
        }),
      ),
    );
    await expect(
      performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch),
    ).rejects.toThrow(
      'The Relay says its origin is https://relay.example, but this build was made for ' +
        "https://dormouse.example. Rebuild Dormouse with DORMOUSE_RELAY_ORIGIN=https://relay.example, or set the Relay's " +
        'DORMOUSE_ORIGIN to https://dormouse.example.',
    );
  });

  it('does not blame a credential for a 401 the Relay did not raise', async () => {
    // A reverse proxy, a rate limiter. Telling the operator to retype a password
    // that was fine is worse than saying only what is known.
    stubLocalStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('Unauthorized', { status: 401 })));
    await expect(
      performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch),
    ).rejects.toThrow('The Relay refused the enrollment (HTTP 401): Unauthorized');
  });

  it('keeps the status and the Relay text on any other refusal', async () => {
    // Nothing here is a user action to name — a reverse proxy, a restarting
    // Relay — so the operator gets both halves of what the Relay said.
    stubLocalStorage();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('gateway is asleep', { status: 502 })));
    await expect(
      performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch),
    ).rejects.toThrow('The Relay refused the enrollment (HTTP 502): gateway is asleep');
  });

  it('keeps a proxy’s error page from becoming the sentence', async () => {
    // The slot is one line in the Settings dialog; a 502 from nginx is a whole
    // HTML document.
    stubLocalStorage();
    const page = `<html>\n<head><title>502 Bad Gateway</title></head>\n${'<hr>'.repeat(200)}`;
    vi.stubGlobal('fetch', vi.fn(async () => new Response(page, { status: 502 })));
    await expect(
      performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch),
    ).rejects.toThrow('The Relay refused the enrollment (HTTP 502): <html>');
  });

  it('refuses a 200 whose body is not an enrollment', async () => {
    // A version skew or a proxy that rewrote the body. Minting from it would
    // hand the Burrow an `undefined` in the `ConnectionPolicy` it authenticates
    // passkeys against, and persist a record that `isEnrollment` rejects on the
    // next read — the machine un-enrolls itself at the next launch with nothing
    // in the log to explain it. Name the missing fields instead.
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ burrowId: BURROW_ID, burrowToken: 'tok-xyz' }), // no origin/rpId
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch)).rejects.toThrow(
      /missing or invalid: origin, rpId/,
    );
  });

  it('refuses a 200 whose fields are the wrong type', async () => {
    // `burrowId: null` type-checks as `BurrowEnrollResponse` only because the body
    // is cast, not parsed; the guard is what actually rejects it. It is present
    // in the body, so the error says "missing or invalid" rather than "missing".
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({ burrowId: null, burrowToken: 'tok-xyz', origin: 'o', rpId: 'r' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );

    await expect(performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch)).rejects.toThrow(
      /missing or invalid: burrowId/,
    );
  });

  it('refuses a burrowId of any shape but the routing id', async () => {
    // The response body is untrusted like any other, and this field is not just
    // stored: it routes every `e2e` envelope and is the second field of every QR
    // fragment, both of which accept exactly 16 bytes as base64url. Accepted
    // here, a wrong-length id would leave this Burrow minting codes no phone can
    // parse, with nothing anywhere to explain it. The Relay pins the same shape
    // at the mint (`relay/src/state.ts`).
    for (const burrowId of ['burrow-abc', '', `${BURROW_ID}A`, BURROW_ID.slice(0, 21), `${BURROW_ID}==`]) {
      expect(
        isEnrollment({ relayUrl: 's', burrowId, burrowToken: 't', origin: 'o', rpId: 'r', ...LOCAL }),
      ).toBe(false);
    }
    expect(
      isEnrollment({ relayUrl: 's', burrowId: BURROW_ID, burrowToken: 't', origin: 'o', rpId: 'r', ...LOCAL }),
    ).toBe(true);

    // And the exchange fails naming the field rather than persisting one.
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        new Response(
          JSON.stringify({
            burrowId: 'burrow-abc',
            burrowToken: 'tok-xyz',
            origin: 'https://dormouse.example',
            rpId: 'dormouse.example',
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        ),
      ),
    );
    await expect(
      performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch),
    ).rejects.toThrow(/missing or invalid: burrowId/);
  });

  it('refuses a 200 that is not JSON at all', async () => {
    // A captive portal or a proxy error page served with a 200.
    stubLocalStorage();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('<html>not your Relay</html>', { status: 200 })),
    );

    await expect(performEnrollment('https://dormouse.example', { password: TEST_SETUP_PASSWORD }, 'x', fetch)).rejects.toThrow(
      /did not answer JSON/,
    );
  });

  it('takes both halves of the Noise static, never one or none', () => {
    // A missing half is a truncated write or a hand-edited file, and a Burrow
    // that believed it had an identity it cannot use is worse than one that
    // knows it has none.
    const base = {
      relayUrl: 's',
      burrowId: BURROW_ID,
      burrowToken: 't',
      origin: 'o',
      rpId: 'r',
      label: 'Laptop',
    };
    const { noiseStaticPublicKey, noiseStaticPrivateKey } = LOCAL;

    expect(isEnrollment(base)).toBe(false);
    expect(isEnrollment({ ...base, noiseStaticPublicKey, noiseStaticPrivateKey })).toBe(true);
    // The label is the operator's answer, kept beside every enrollment.
    expect(isEnrollment({ ...base, label: undefined, noiseStaticPublicKey, noiseStaticPrivateKey })).toBe(false);
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

});

describe('Hosted device-code enrollment', () => {
  afterEach(() => vi.unstubAllGlobals());

  const RELAY = 'https://relay.dormouse.sh';
  const BEGIN = {
    deviceCode: 'D'.repeat(RELAY_BEARER_LENGTH),
    userCode: '23AB-YZ9K',
    verificationUrl: 'https://hosted.dormouse.sh/enroll#23AB-YZ9K',
    expiresAt: 1_800_000_000_000,
    interval: 5,
  };
  const json = (status: number, body: unknown) =>
    vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('begins with the baked origin alone, minting the Noise static first', async () => {
    const fetchMock = json(200, BEGIN);
    const { begin, noiseStatic } = await beginHostedEnrollment(RELAY, fetchMock as unknown as typeof fetch);

    expect(begin).toEqual(BEGIN);
    expect(fetchMock.mock.calls[0]![0]).toBe(`${RELAY}/api/burrow/enroll/begin`);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    expect(init.redirect).toBe('error');
    expect(JSON.parse(init.body as string)).toEqual({ origin: RELAY });
    expect(JSON.stringify(init.body)).not.toContain(noiseStatic.noiseStaticPublicKey);

    // A runtime that cannot mint fails before the Relay is asked anything.
    vi.mocked(mintNoiseStaticKeyPair).mockRejectedValueOnce(new Error('no X25519 here'));
    const unasked = json(200, BEGIN);
    await expect(beginHostedEnrollment(RELAY, unasked as unknown as typeof fetch)).rejects.toThrow(
      /cannot generate the X25519 key/,
    );
    expect(unasked).not.toHaveBeenCalled();
  });

  it('refuses a begin answer that is not an enrollment code, and names a refused origin', async () => {
    await expect(
      beginHostedEnrollment(RELAY, json(200, { ...BEGIN, interval: 0 }) as unknown as typeof fetch),
    ).rejects.toThrow(/not an enrollment code/);
    await expect(
      beginHostedEnrollment(
        RELAY,
        json(409, { error: ORIGIN_MISMATCH_ERROR, origin: 'https://relay.example.com' }) as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/The Relay says its origin is https:\/\/relay.example.com/);
  });

  describe('a poll', () => {
    let noiseStatic: EnrollmentStatic;
    beforeAll(async () => {
      const material = await mintNoiseStaticKeyPair();
      noiseStatic = { noiseStaticPrivateKey: material.privateKeyPkcs8, noiseStaticPublicKey: material.publicKey };
    });
    const poll = (fetchMock: unknown) =>
      pollHostedEnrollment(RELAY, BEGIN.deviceCode, 'My Laptop', noiseStatic, fetchMock as typeof fetch);

    it('posts the device code alone, and maps an enrolled answer through the enrollment guard', async () => {
      const enrollment = { burrowId: BURROW_ID, burrowToken: 'tok', origin: RELAY, rpId: 'relay.dormouse.sh' };
      const fetchMock = json(200, { status: 'enrolled', enrollment });

      const answer = await poll(fetchMock);

      expect(fetchMock.mock.calls[0]![0]).toBe(`${RELAY}/api/burrow/enroll/poll`);
      const init = fetchMock.mock.calls[0]![1] as RequestInit;
      expect(init.redirect).toBe('error');
      expect(JSON.parse(init.body as string)).toEqual({ deviceCode: BEGIN.deviceCode });
      expect(answer).toEqual({
        status: 'enrolled',
        enrollment: { relayUrl: RELAY, ...enrollment, label: 'My Laptop', ...noiseStatic },
      });
      expect(isEnrollment((answer as { enrollment: unknown }).enrollment)).toBe(true);
      // A redemption the guard refuses fails, naming the field.
      expect(await poll(json(200, { status: 'enrolled', enrollment: { ...enrollment, burrowId: 'short' } })))
        .toEqual({ status: 'failed', message: expect.stringContaining('burrowId') });
    });

    it('reads pending, expired, and redeemed as they are', async () => {
      expect(await poll(json(200, { status: 'pending' }))).toEqual({ status: 'pending' });
      expect(await poll(json(200, { status: 'expired' }))).toEqual({ status: 'expired' });
      // An earlier poll's redemption whose answer never arrived, naming the
      // Burrow it enrolled.
      const burrowId = 'A'.repeat(22);
      expect(await poll(json(200, { status: 'redeemed', burrowId, extra: 1 }))).toEqual({ status: 'redeemed', burrowId });
      // One that names no Burrow is no answer this build reads.
      expect(await poll(json(200, { status: 'redeemed' }))).toEqual({
        status: 'failed',
        message: expect.stringContaining('not an enrollment poll'),
      });
    });

    it('retries what told it nothing, slowing down on a 429', async () => {
      expect(await poll(vi.fn(async () => Promise.reject(new Error('offline'))))).toEqual({
        status: 'retry',
        slowDown: false,
      });
      expect(await poll(json(503, { error: 'unavailable' }))).toEqual({ status: 'retry', slowDown: false });
      expect(await poll(json(429, { error: 'too many enrollment attempts' }))).toEqual({
        status: 'retry',
        slowDown: true,
      });
    });

    it('refuses for the two reasons the panel words, and fails on anything else', async () => {
      expect(await poll(json(403, { error: NOT_ENTITLED_ERROR }))).toEqual({
        status: 'refused',
        reason: 'not-entitled',
      });
      expect(await poll(json(409, { error: 'this account already has 32 computers enrolled' }))).toEqual({
        status: 'refused',
        reason: 'account-full',
      });
      // A 403 the Relay did not raise for the entitlement is not one.
      expect(await poll(json(403, { error: 'forbidden' }))).toEqual({
        status: 'failed',
        message: 'The Relay refused the enrollment (HTTP 403): {"error":"forbidden"}',
      });
      expect(await poll(json(200, { status: 'approved' }))).toEqual({
        status: 'failed',
        message: expect.stringContaining('not an enrollment poll'),
      });
    });
  });
});

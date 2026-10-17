/**
 * What a person reads when a Burrow request gets no answer: the host and why,
 * from undici's `cause`, never a bare `fetch failed` and never the whole URL.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  API_ROUTES,
  NOT_ENTITLED_ERROR,
  UNAUTHORIZED_ERROR,
  UNKNOWN_BURROW_TOKEN_ERROR,
} from 'remote-lib-common';

import { burrowFetch, describeFetchFailure, describingFetchFailures, probeBurrowStanding } from './burrow-fetch';

const URL_WITH_PATH = 'https://relay.dormouse.sh/api/burrow/enroll/begin?x=1';

/** What undici rejects with: a `TypeError` whose `cause` carries the system code. */
function undiciFailure(code: string, message = `connect ${code}`): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return Object.assign(new TypeError('fetch failed'), { cause });
}

describe('describeFetchFailure', () => {
  it('names the host and why, never the path', () => {
    for (const [error, why] of [
      [undiciFailure('ENOTFOUND'), 'the name doesn’t resolve'],
      [undiciFailure('EAI_AGAIN'), 'the name doesn’t resolve'],
      [undiciFailure('ECONNREFUSED'), 'the connection was refused'],
      [undiciFailure('UND_ERR_CONNECT_TIMEOUT'), 'it didn’t answer in time'],
      [undiciFailure('ETIMEDOUT'), 'it didn’t answer in time'],
      [new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'it didn’t answer in time'],
      [new DOMException('This operation was aborted', 'AbortError'), 'it didn’t answer in time'],
      [undiciFailure('CERT_HAS_EXPIRED'), 'its certificate was rejected'],
      [undiciFailure('ERR_TLS_CERT_ALTNAME_INVALID'), 'its certificate was rejected'],
      [undiciFailure('DEPTH_ZERO_SELF_SIGNED_CERT'), 'its certificate was rejected'],
      [undiciFailure('ECONNRESET'), 'ECONNRESET'],
    ] as const) {
      expect(describeFetchFailure(URL_WITH_PATH, error), why).toBe(`Couldn’t reach relay.dormouse.sh: ${why}.`);
    }
  });

  it('reads a code off the first error of an AggregateError, and falls back to the cause’s message', () => {
    const aggregate = Object.assign(new TypeError('fetch failed'), {
      cause: Object.assign(new AggregateError([Object.assign(new Error('x'), { code: 'ECONNREFUSED' })]), {}),
    });
    expect(describeFetchFailure('http://localhost:8787/x', aggregate)).toBe(
      'Couldn’t reach localhost:8787: the connection was refused.',
    );
    const redirect = Object.assign(new TypeError('fetch failed'), { cause: new Error('unexpected redirect') });
    expect(describeFetchFailure(URL_WITH_PATH, redirect)).toBe('Couldn’t reach relay.dormouse.sh: unexpected redirect.');
  });
});

describe('describingFetchFailures', () => {
  it('rejects with the sentence where the request got no answer, and passes an answer through', async () => {
    const failing = describingFetchFailures(() => Promise.reject(undiciFailure('ENOTFOUND')));
    await expect(failing(URL_WITH_PATH)).rejects.toThrow('Couldn’t reach relay.dormouse.sh: the name doesn’t resolve.');
    await expect(failing(new URL(URL_WITH_PATH))).rejects.toThrow('relay.dormouse.sh');
    const underlying = undiciFailure('ECONNREFUSED');
    await expect(describingFetchFailures(() => Promise.reject(underlying))(URL_WITH_PATH)).rejects.toMatchObject({
      cause: underlying,
    });

    const answer = new Response('', { status: 503 });
    expect(await describingFetchFailures(() => Promise.resolve(answer))(URL_WITH_PATH)).toBe(answer);
  });
});

describe('probeBurrowStanding', () => {
  const enrollment = { relayUrl: 'https://relay.example', burrowToken: 'tok' };
  const answering = (status: number, body: unknown) => {
    const asked: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetch = (async (url: string, init?: RequestInit) => {
      asked.push({ url, init });
      return new Response(body === undefined ? null : JSON.stringify(body), { status });
    }) as unknown as typeof globalThis.fetch;
    return { asked, probe: () => probeBurrowStanding({ enrollment, fetch }) };
  };

  it('asks the push-devices read as this Burrow, bounded and refusing redirects', async () => {
    const { asked, probe } = answering(200, { devices: [] });
    expect(await probe()).toBeNull();
    expect(asked).toHaveLength(1);
    expect(asked[0]!.url).toBe(`https://relay.example${API_ROUTES.pushDevices}`);
    expect(asked[0]!.init?.redirect).toBe('error');
    expect(asked[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect((asked[0]!.init?.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('reads a Burrow gate’s 401 as removed and a 403 not-entitled as not-entitled, and nothing else', async () => {
    for (const [status, body, standing] of [
      [401, { error: UNAUTHORIZED_ERROR }, 'removed'],
      [401, { error: UNKNOWN_BURROW_TOKEN_ERROR }, 'removed'],
      [403, { error: NOT_ENTITLED_ERROR }, 'not-entitled'],
      // A 401 or 403 that is not the Relay's own — a proxy's — proves nothing.
      [401, { error: 'proxy auth required' }, null],
      [401, undefined, null],
      [403, { error: 'forbidden' }, null],
      [403, { error: UNAUTHORIZED_ERROR }, null],
      [401, { error: NOT_ENTITLED_ERROR }, null],
    ] as const) {
      expect(await answering(status, body).probe(), `${status} ${JSON.stringify(body)}`).toBe(standing);
    }
  });

  it('rejects any other status, which is no answer about the token', async () => {
    for (const [status, body] of [
      [500, { error: UNAUTHORIZED_ERROR }],
      [502, undefined],
      [404, undefined],
      [429, undefined],
    ] as const) {
      await expect(answering(status, body).probe(), `${status}`).rejects.toThrow(`answered ${status}`);
    }
  });

  it('rejects when no answer came', async () => {
    const fetch = (async () => {
      throw new TypeError('fetch failed');
    }) as unknown as typeof globalThis.fetch;
    await expect(probeBurrowStanding({ enrollment, fetch })).rejects.toThrow('fetch failed');
  });
});

describe('burrowFetch transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The fetch is the Burrow service's policy-guarded one
  // (`docs/specs/remote-network.md` -> "Policy"); a caller that omits it fails,
  // never reaching the network around the guard.
  it('has no default fetch to fall back on', async () => {
    const globalFetch = vi.fn(async () => new Response('{}'));
    vi.stubGlobal('fetch', globalFetch);
    const options = { enrollment: { relayUrl: 'https://relay.example', burrowToken: 'tok' } };
    await expect(burrowFetch(options as unknown as Parameters<typeof burrowFetch>[0], API_ROUTES.pushDevices)).rejects.toThrow();
    await expect(probeBurrowStanding(options as unknown as Parameters<typeof probeBurrowStanding>[0])).rejects.toThrow();
    expect(globalFetch).not.toHaveBeenCalled();
  });
});

/**
 * What a person reads when a Burrow request gets no answer: the host and why,
 * from undici's `cause`, never a bare `fetch failed` and never the whole URL.
 */

import { describe, expect, it } from 'vitest';

import { describeFetchFailure, describingFetchFailures } from './burrow-fetch';

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

    const answer = new Response('', { status: 503 });
    expect(await describingFetchFailures(() => Promise.resolve(answer))(URL_WITH_PATH)).toBe(answer);
  });
});

/**
 * Pocket's deployment (`docs/specs/remote-network.md` -> "Anywhere"): one
 * bundle gathers through Cloudflare STUN where Hosted serves it and through
 * nothing where a self-host Relay does, told apart by the file Hosted's
 * staging writes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { HOSTED_POCKET_DEPLOYMENT, POCKET_DEPLOYMENT_FILE } from 'remote-lib-common';

import { CLOUDFLARE_STUN_URL } from '../direct/ice-servers';
import {
  POCKET_DEPLOYMENT_PATH,
  POCKET_DEPLOYMENT_READ_TIMEOUT_MS,
  deploymentDirectPeer,
  deploymentUnreachableMessage,
  parsePocketDeployment,
  pocketDeploymentSource,
  readPocketDeployment,
} from './deployment';

/** A fetch answering only {@link POCKET_DEPLOYMENT_PATH}, with `respond`. */
function serving(
  respond: (init?: RequestInit) => Response | Promise<Response>,
): typeof globalThis.fetch {
  return async (input, init) => {
    expect(input).toBe(POCKET_DEPLOYMENT_PATH);
    return respond(init);
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Pocket’s deployment', () => {
  it('reads Hosted from exactly what Hosted’s staging writes, at the path it writes it', async () => {
    expect(POCKET_DEPLOYMENT_PATH).toBe(`/${POCKET_DEPLOYMENT_FILE}`);
    // As `hosted/scripts/stage-relay.mjs` writes it.
    expect(
      await readPocketDeployment(serving(() => new Response(`${JSON.stringify(HOSTED_POCKET_DEPLOYMENT)}\n`))),
    ).toBe('hosted');
  });

  it('reads self-host from a self-host Relay’s shell, a 404, and any other complete body', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      // The SPA fallback a self-host Relay answers every unknown path with.
      () => new Response('<!doctype html><title>Pocket</title>', { headers: { 'content-type': 'text/html' } }),
      () => new Response('Not Found', { status: 404 }),
      () => new Response(JSON.stringify(HOSTED_POCKET_DEPLOYMENT), { status: 403 }),
      () => new Response('{"deployment":"Hosted"}'),
      () => new Response('{"deployment":["hosted"]}'),
      () => new Response('null'),
    ];
    for (const answer of answers) {
      expect(await readPocketDeployment(serving(answer))).toBe('self-host');
    }
    expect(parsePocketDeployment({ deployment: 'hosted' })).toBe('hosted');
    expect(parsePocketDeployment('hosted')).toBe('self-host');
  });

  it('reads nothing from a read that does not complete: a failure, a 5xx, a body lost mid-read', async () => {
    const lostBody = () =>
      new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"deploy'));
            controller.error(new TypeError('connection reset'));
          },
        }),
      );
    const answers: Array<() => Response | Promise<Response>> = [
      () => Promise.reject(new TypeError('offline')),
      () => new Response(JSON.stringify(HOSTED_POCKET_DEPLOYMENT), { status: 500 }),
      () => new Response('Bad Gateway', { status: 502 }),
      lostBody,
    ];
    for (const answer of answers) {
      expect(await readPocketDeployment(serving(answer))).toBeNull();
    }
  });

  it('reads nothing past its bound, and aborts the read', async () => {
    vi.useFakeTimers();
    let signal: AbortSignal | undefined;
    const read = readPocketDeployment(async (_input, init) => {
      signal = init?.signal ?? undefined;
      return new Promise<Response>(() => {});
    });
    await vi.advanceTimersByTimeAsync(POCKET_DEPLOYMENT_READ_TIMEOUT_MS);
    expect(await read).toBeNull();
    expect(signal?.aborted).toBe(true);
  });
});

describe('Pocket’s deployment source', () => {
  const HOST = 'relay.dormouse.sh';

  /** A fetch answering each read with the next of `answers`, counting reads. */
  function answering(answers: Array<() => Response | Promise<Response>>) {
    const reads = { count: 0 };
    const fetch = serving(() => {
      reads.count += 1;
      return answers.shift()!();
    });
    return { fetch, reads };
  }

  it('caches a self-host shell at once, and reads it once', async () => {
    const { fetch, reads } = answering([() => new Response('<!doctype html>')]);
    const source = pocketDeploymentSource(fetch, HOST);
    expect(source.known).toBeNull();
    expect(await source.require()).toBe('self-host');
    expect(source.known).toBe('self-host');
    expect(await source.require()).toBe('self-host');
    expect(reads.count).toBe(1);
  });

  it('caches nothing from a failed read, and reads again on the next require', async () => {
    const { fetch, reads } = answering([
      () => Promise.reject(new TypeError('offline')),
      () => new Response(JSON.stringify(HOSTED_POCKET_DEPLOYMENT)),
    ]);
    const source = pocketDeploymentSource(fetch, HOST);
    await expect(source.require()).rejects.toThrow(deploymentUnreachableMessage(HOST));
    expect(source.known).toBeNull();
    expect(await source.require()).toBe('hosted');
    expect(reads.count).toBe(2);
  });

  it('caches nothing from a timed-out read', async () => {
    vi.useFakeTimers();
    const { fetch, reads } = answering([
      () => new Promise<Response>(() => {}),
      () => new Response(JSON.stringify(HOSTED_POCKET_DEPLOYMENT)),
    ]);
    const source = pocketDeploymentSource(fetch, HOST);
    const first = source.require();
    const failed = expect(first).rejects.toThrow(deploymentUnreachableMessage(HOST));
    await vi.advanceTimersByTimeAsync(POCKET_DEPLOYMENT_READ_TIMEOUT_MS);
    await failed;
    expect(source.known).toBeNull();
    expect(await source.require()).toBe('hosted');
    expect(reads.count).toBe(2);
  });

  it('shares one read between concurrent requires', async () => {
    const { fetch, reads } = answering([() => new Response(JSON.stringify(HOSTED_POCKET_DEPLOYMENT))]);
    const source = pocketDeploymentSource(fetch, HOST);
    expect(await Promise.all([source.require(), source.require()])).toEqual(['hosted', 'hosted']);
    expect(reads.count).toBe(1);
  });
});

describe('Pocket’s direct-peer factory', () => {
  it('builds no peer before the deployment is known, then the one it names', async () => {
    const built: unknown[] = [];
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor(config: unknown) {
          built.push(config);
        }
      },
    );
    let answer!: (response: Response) => void;
    const hosted = pocketDeploymentSource(
      serving(() => new Promise<Response>((resolve) => (answer = resolve))),
      'relay.dormouse.sh',
    );
    const factory = deploymentDirectPeer(hosted);
    const read = hosted.require();
    // An unresolved read never gathers through no ICE server.
    expect(factory()).toBeNull();
    answer(new Response(JSON.stringify(HOSTED_POCKET_DEPLOYMENT)));
    await read;
    factory();

    const selfHost = pocketDeploymentSource(serving(() => new Response('Not Found', { status: 404 })), 'relay.example');
    await selfHost.require();
    deploymentDirectPeer(selfHost)();
    expect(built).toEqual([{ iceServers: [{ urls: CLOUDFLARE_STUN_URL }] }, { iceServers: [] }]);
  });
});

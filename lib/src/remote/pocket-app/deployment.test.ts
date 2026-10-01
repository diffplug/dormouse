/**
 * Pocket's deployment (`docs/specs/remote-network.md` -> "Anywhere"): one
 * bundle gathers through Cloudflare STUN where Hosted serves it and through
 * nothing where a self-host Relay does, told apart by the file Hosted's
 * staging writes.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

// @ts-expect-error -- a plain build script, deliberately not part of the app's
// TypeScript program; Hosted's staging writes exactly these.
import { DEPLOYMENT_FILE, HOSTED_DEPLOYMENT_BODY } from '../../../scripts/assert-pocket-worker.mjs';
import { CLOUDFLARE_STUN_URL } from '../direct/ice-servers';
import {
  POCKET_DEPLOYMENT_PATH,
  deploymentDirectPeer,
  parsePocketDeployment,
  readPocketDeployment,
} from './deployment';

/** A fetch answering only {@link POCKET_DEPLOYMENT_PATH}, with `respond`. */
function serving(respond: () => Response | Promise<Response>): typeof globalThis.fetch {
  return async (input) => {
    expect(input).toBe(POCKET_DEPLOYMENT_PATH);
    return respond();
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('Pocket’s deployment', () => {
  it('reads Hosted from exactly what Hosted’s staging writes, at the path it writes it', async () => {
    expect(POCKET_DEPLOYMENT_PATH).toBe(`/${DEPLOYMENT_FILE}`);
    expect(await readPocketDeployment(serving(() => new Response(HOSTED_DEPLOYMENT_BODY)))).toBe('hosted');
  });

  it('reads self-host from a self-host Relay’s shell, a 404, a failure, and any other body', async () => {
    const answers: Array<() => Response | Promise<Response>> = [
      // The SPA fallback a self-host Relay answers every unknown path with.
      () => new Response('<!doctype html><title>Pocket</title>', { headers: { 'content-type': 'text/html' } }),
      () => new Response('Not Found', { status: 404 }),
      () => new Response(HOSTED_DEPLOYMENT_BODY, { status: 500 }),
      () => Promise.reject(new TypeError('offline')),
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

  it('gathers through STUN only once Hosted is read, and through nothing before', async () => {
    const built: unknown[] = [];
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor(config: unknown) {
          built.push(config);
        }
      },
    );
    let settle!: (deployment: 'hosted' | 'self-host') => void;
    const factory = deploymentDirectPeer(new Promise((resolve) => (settle = resolve)));
    factory();
    settle('hosted');
    await Promise.resolve();
    factory();
    const selfHost = deploymentDirectPeer(Promise.resolve('self-host'));
    await Promise.resolve();
    selfHost();
    expect(built).toEqual([
      { iceServers: [] },
      { iceServers: [{ urls: CLOUDFLARE_STUN_URL }] },
      { iceServers: [] },
    ]);
  });
});

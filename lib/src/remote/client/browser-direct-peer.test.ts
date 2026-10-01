/**
 * The phone's two factories (`docs/specs/remote-network.md` -> "Anywhere"):
 * which ICE servers a page's peers gather through is fixed by who serves it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { CLOUDFLARE_STUN_URL } from '../direct/ice-servers';
import { hostedDirectPeer, selfHostDirectPeer } from './browser-direct-peer';

/** Every configuration a stubbed `RTCPeerConnection` was built with. */
let built: unknown[];

/** Stand in for the browser's `RTCPeerConnection`, recording its configuration. */
function stubPeerConnection(): void {
  built = [];
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      constructor(config: unknown) {
        built.push(config);
      }
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('the browser’s direct-peer factories', () => {
  it('gathers through Cloudflare STUN on a page Hosted serves', () => {
    stubPeerConnection();
    expect(hostedDirectPeer()).not.toBeNull();
    expect(built).toEqual([{ iceServers: [{ urls: CLOUDFLARE_STUN_URL }] }]);
  });

  it('gathers through no ICE server on a page a self-host Relay serves', () => {
    stubPeerConnection();
    expect(selfHostDirectPeer()).not.toBeNull();
    expect(built).toEqual([{ iceServers: [] }]);
  });

  it('answers null in a browser without WebRTC', () => {
    vi.stubGlobal('RTCPeerConnection', undefined);
    expect(hostedDirectPeer()).toBeNull();
    expect(selfHostDirectPeer()).toBeNull();
  });
});

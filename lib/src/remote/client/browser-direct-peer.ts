/**
 * The phone's direct-path factories: the browser's own `RTCPeerConnection`
 * (`docs/specs/remote-api.md` → Transport → "Direct path"), as
 * `createNativeDirectPeerFactory` is the Burrows' one. Which ICE servers each
 * gathers through: `docs/specs/remote-network.md` -> "Anywhere".
 */

import type { DirectPeerFactory } from '../direct/direct-peer';
import { stunServers } from '../direct/ice-servers';

/**
 * A fresh peer connection per offer, or `null` in a browser without WebRTC —
 * where Pocket keeps its session relayed and the one-time page, which gates on
 * `RTCPeerConnection`, never gets this far.
 */
function browserDirectPeer(stun: boolean): DirectPeerFactory {
  return () =>
    typeof RTCPeerConnection === 'undefined'
      ? null
      : new RTCPeerConnection({ iceServers: stunServers(stun) });
}

/** The one-time page's, which Hosted serves. */
export const hostedDirectPeer: DirectPeerFactory = browserDirectPeer(true);

/** Pocket's, which a self-host Relay serves. */
export const selfHostDirectPeer: DirectPeerFactory = browserDirectPeer(false);

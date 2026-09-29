/**
 * The phone's direct-path factory: the browser's own `RTCPeerConnection`
 * (`docs/specs/remote-api.md` → Transport → "Direct path"). One copy for every
 * phone page, as `createNativeDirectPeerFactory` is the Burrows' one.
 */

import type { DirectPeerFactory } from '../direct/direct-peer';

/**
 * A fresh peer connection per offer, or `null` in a browser without WebRTC —
 * where Pocket keeps its session relayed and the one-time page, which gates on
 * `RTCPeerConnection`, never gets this far.
 *
 * **No ICE servers**: a public STUN or TURN default would hand a third party
 * this phone's address, and host candidates are what reach the computer on a
 * tailnet or the same Wi-Fi.
 */
export const browserDirectPeer: DirectPeerFactory = () =>
  typeof RTCPeerConnection === 'undefined' ? null : new RTCPeerConnection({ iceServers: [] });

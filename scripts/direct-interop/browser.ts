/**
 * The browser half of the direct path's interop fixture: the Client's side,
 * exactly as Pocket builds it (`docs/specs/remote-api.md` -> Transport ->
 * "Direct path").
 *
 * Bundled and served by `./run.mjs`; see its header for how to run the pair.
 * The wrapper under test is the shipped `DirectPeer` — nothing here
 * reimplements a negotiation — over the browser's own `RTCPeerConnection` with
 * no ICE servers, which is the one combination the in-process suites cannot
 * reach: `direct-peer.test.ts` links two fakes, and `native-direct-peer.test.ts`
 * runs the addon against itself.
 */

import { MAX_DIRECT_SDP_LENGTH } from 'remote-lib-common';
import { DirectPeer, type DirectPeerLike } from '../../lib/src/remote/direct/direct-peer';

/** What the page reports back for `run.mjs` to print. Test data only. */
export interface BrowserReport {
  readonly ok: boolean;
  readonly error?: string;
  /** The offer this browser actually produced, against the signal's bound. */
  readonly offerSdpLength?: number;
  readonly maxDirectSdpLength: number;
  /** Candidate lines in that offer — what makes a multi-homed machine large. */
  readonly candidates?: number;
  /** The association's own per-message limit, as this browser reports it. */
  readonly maxMessageSize?: number | null;
  /** The size of every frame echoed back, in the order this end saw them. */
  readonly echoed?: number[];
}

declare const __INTEROP_TOKEN__: string;

/** How long the echo half waits before reporting what it did get. */
const ECHO_BUDGET_MS = 10_000;

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${path}?t=${encodeURIComponent(__INTEROP_TOKEN__)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

async function run(): Promise<BrowserReport> {
  const echoed: number[] = [];
  const connection = new RTCPeerConnection({ iceServers: [] }) as unknown as DirectPeerLike;
  const opened = Promise.withResolvers<void>();
  const lost = Promise.withResolvers<never>();
  let expected = 0;
  const allEchoed = Promise.withResolvers<void>();

  const peer: DirectPeer = new DirectPeer({
    peer: connection,
    handlers: {
      onOpen: () => opened.resolve(),
      // The addon's side sends; this end echoes each frame straight back, so
      // the bytes and the order they arrive in are checked over a real
      // association rather than a linked pair.
      onFrame: (frame) => {
        echoed.push(frame.length);
        peer.send(frame);
        if (echoed.length >= expected) allEchoed.resolve();
      },
      onClosed: (reason) => lost.reject(new Error(reason)),
      onViolation: (reason) => lost.reject(new Error(reason)),
    },
  });

  const sdp = await peer.offer();
  const measured = {
    maxDirectSdpLength: MAX_DIRECT_SDP_LENGTH,
    offerSdpLength: sdp?.length,
    candidates: sdp ? (sdp.match(/^a=candidate/gm) ?? []).length : undefined,
  };
  // `offer()` answers null for a description this end would not send, which on
  // a machine with many interfaces is the interesting outcome rather than a
  // crash: the attempt is skipped and the session stays relayed.
  if (!sdp) return { ...measured, ok: false, error: 'the offer did not fit one signal' };

  const answer = (await post('/answer', { sdp })) as {
    sdp?: string;
    frames?: number;
    error?: string;
  };
  if (!answer.sdp) return { ...measured, ok: false, error: answer.error ?? 'no answer' };
  expected = answer.frames ?? 0;
  await peer.acceptAnswer(answer.sdp);
  await Promise.race([opened.promise, lost.promise]);

  const timeout = new Promise<void>((resolve) => setTimeout(resolve, ECHO_BUDGET_MS));
  await Promise.race([allEchoed.promise, lost.promise, timeout]);

  return {
    ...measured,
    ok: echoed.length === expected,
    error: echoed.length === expected ? undefined : `echoed ${echoed.length} of ${expected}`,
    maxMessageSize: connection.sctp?.maxMessageSize ?? null,
    echoed,
  };
}

function show(report: BrowserReport): void {
  document.body.textContent = JSON.stringify(report, null, 2);
  void post('/report', report);
}

run().then(show, (error: unknown) => {
  show({ ok: false, error: String(error), maxDirectSdpLength: MAX_DIRECT_SDP_LENGTH });
});

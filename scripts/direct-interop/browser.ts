/**
 * The browser half of the direct path's interop fixture: the Client's side,
 * exactly as Pocket builds it (`docs/specs/remote-api.md` -> Transport ->
 * "Direct path"), or under `--stun` as the one-time page Hosted serves does.
 *
 * Bundled and served by `./run.mjs`; see its header for how to run the pair.
 * The wrapper under test is the shipped `DirectPeer` — nothing here
 * reimplements a negotiation — over the browser's own `RTCPeerConnection`, built
 * by the shipped factory, which is the one combination the in-process suites
 * cannot reach: `direct-peer.test.ts` links two fakes, and
 * `native-direct-peer.test.ts` runs the addon against itself.
 */

import { MAX_DIRECT_SDP_LENGTH } from 'remote-lib-common';
import { DirectPeer } from '../../lib/src/remote/direct/direct-peer';
import { hostedDirectPeer, selfHostDirectPeer } from '../../lib/src/remote/client/browser-direct-peer';

/** The two shipped page factories, by the name the report gives. */
const FACTORIES = { hostedDirectPeer, selfHostDirectPeer };

/** One end of the selected pair, as `getStats()` reports it. */
export interface PairEnd {
  readonly candidateType?: string;
  readonly protocol?: string;
  readonly address?: string;
}

/**
 * What the page reports back for `run.mjs` to print. Test data only. Its offer
 * is not here: `run.mjs` describes the one it was sent.
 *
 * **Measurements, not a verdict.** `run.mjs` decides whether the run passed,
 * against the frames it actually got back — the strictly stronger check, and
 * one definition of "finished" rather than two that can disagree.
 */
export interface BrowserReport {
  readonly error?: string;
  readonly userAgent?: string;
  /** Which shipped factory built the peer: `hostedDirectPeer` under `--stun`. */
  readonly factory?: keyof typeof FACTORIES;
  /** The ICE servers that factory configured, as this browser reports them. */
  readonly iceServers?: RTCIceServer[];
  readonly maxDirectSdpLength: number;
  /** The length of an offer that did not fit one signal, and so was never sent. */
  readonly offerSdpLength?: number;
  /** `offer()` start to the SDP in hand: gathering, settled as `DirectPeer` settles it. */
  readonly offerMs?: number;
  /**
   * `iceGatheringState` when the offer was taken — anything but `complete`
   * means `DIRECT_SRFLX_GRACE_MS` or `DIRECT_GATHER_TIMEOUT_MS` settled it.
   */
  readonly gatheringStateAtOffer?: string;
  /** When gathering reported `complete`, if it did before the report went. */
  readonly gatheringCompleteMs?: number | null;
  /** Every `icecandidateerror` before the report went: a STUN server that timed out, say. */
  readonly candidateErrors?: Array<{ atMs: number; url: string; errorCode: number; errorText: string; address: string | null }>;
  /** `offer()` start to the channel's open. */
  readonly openMs?: number;
  /** The selected pair, from `getStats()`, once the channel had settled. */
  readonly selectedPair?: { local: PairEnd; remote: PairEnd } | null;
  /** The association's own per-message limit, as this browser reports it. */
  readonly maxMessageSize?: number | null;
  /** The size of every frame echoed back, in the order this end saw them. */
  readonly echoed?: number[];
}

declare const __INTEROP_TOKEN__: string;
/** Whether this page is the one-time page Hosted serves (`--stun`), rather than Pocket. */
declare const __INTEROP_STUN__: boolean;

/** How long after the channel opens the page reports what it echoed. */
const ECHO_SETTLE_MS = 2_000;

async function post(path: string, body: unknown): Promise<unknown> {
  const response = await fetch(`${path}?t=${encodeURIComponent(__INTEROP_TOKEN__)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}`);
  return response.json();
}

/** The selected pair as `getStats()` reports it, or `null` where it names none. */
async function selectedPair(connection: RTCPeerConnection): Promise<{ local: PairEnd; remote: PairEnd } | null> {
  const stats = await connection.getStats();
  let pair: RTCIceCandidatePairStats | undefined;
  for (const entry of stats.values()) {
    if (entry.type === 'transport' && entry.selectedCandidatePairId) pair = stats.get(entry.selectedCandidatePairId);
  }
  if (!pair) return null;
  const end = (id: string): PairEnd => {
    const { candidateType, protocol, address } = stats.get(id) ?? {};
    return { candidateType, protocol, address };
  };
  return { local: end(pair.localCandidateId), remote: end(pair.remoteCandidateId) };
}

async function run(): Promise<BrowserReport> {
  const echoed: number[] = [];
  const factory: keyof typeof FACTORIES = __INTEROP_STUN__ ? 'hostedDirectPeer' : 'selfHostDirectPeer';
  const connection = FACTORIES[factory]();
  if (!connection) return { error: 'this browser has no RTCPeerConnection', maxDirectSdpLength: MAX_DIRECT_SDP_LENGTH };
  /** The same connection, for what only a browser's has. */
  const rtc = connection as unknown as RTCPeerConnection;
  const opened = Promise.withResolvers<void>();
  const lost = Promise.withResolvers<never>();

  // Watched beside the wrapper, which listens for the same events: the wrapper
  // decides when to stop waiting, and these only say when each thing happened.
  const start = performance.now();
  const since = (): number => Math.round(performance.now() - start);
  /** Each candidate as `icecandidate` reported it, and when; `run.mjs` matches them to the offer's lines. */
  const candidateTimes: Array<[string, number]> = [];
  let gatheringCompleteMs: number | null = null;
  const candidateErrors: NonNullable<BrowserReport['candidateErrors']> = [];
  rtc.addEventListener('icecandidateerror', (error) => {
    candidateErrors.push({
      atMs: since(),
      url: error.url,
      errorCode: error.errorCode,
      errorText: error.errorText,
      address: error.address,
    });
  });
  rtc.addEventListener('icecandidate', (ev) => {
    if (ev.candidate) candidateTimes.push([ev.candidate.candidate, since()]);
  });
  rtc.addEventListener('icegatheringstatechange', () => {
    if (rtc.iceGatheringState === 'complete') gatheringCompleteMs ??= since();
  });
  let openMs: number | undefined;

  const peer: DirectPeer = new DirectPeer({
    peer: connection,
    handlers: {
      onOpen: () => {
        openMs = since();
        opened.resolve();
      },
      // The addon's side sends; this end echoes each frame straight back, so
      // the bytes and the order they arrive in are checked over a real
      // association rather than a linked pair. The frame is a view over the
      // event's buffer, and `send` may queue it — so it is copied here, which
      // production never has to do.
      onFrame: (frame) => {
        echoed.push(frame.length);
        peer.send(frame.slice());
      },
      onClosed: (reason) => lost.reject(new Error(reason)),
      onViolation: (reason) => lost.reject(new Error(reason)),
    },
  });

  const sdp = await peer.offer();
  const measured = {
    userAgent: navigator.userAgent,
    factory,
    iceServers: rtc.getConfiguration().iceServers,
    maxDirectSdpLength: MAX_DIRECT_SDP_LENGTH,
    offerMs: since(),
    gatheringStateAtOffer: rtc.iceGatheringState,
  };
  // `offer()` answers null for a description this end would not send, which on
  // a machine with many interfaces is the interesting outcome rather than a
  // crash: the attempt is skipped and the session stays relayed.
  if (!sdp) {
    return { ...measured, offerSdpLength: rtc.localDescription?.sdp.length, error: 'the offer did not fit one signal' };
  }

  const answer = (await post('/answer', { sdp, candidateTimes })) as { sdp?: string; error?: string };
  if (!answer.sdp) return { ...measured, error: answer.error ?? 'no answer' };
  await peer.acceptAnswer(answer.sdp);
  await Promise.race([opened.promise, lost.promise]);

  const settled = new Promise<void>((resolve) => setTimeout(resolve, ECHO_SETTLE_MS));
  await Promise.race([settled, lost.promise]);

  return {
    ...measured,
    gatheringCompleteMs,
    candidateErrors,
    openMs,
    selectedPair: await selectedPair(rtc),
    maxMessageSize: connection.sctp?.maxMessageSize ?? null,
    echoed,
  };
}

function show(report: BrowserReport): void {
  document.body.textContent = JSON.stringify(report, null, 2);
  void post('/report', report);
}

run().then(show, (error: unknown) => {
  show({ error: String(error), maxDirectSdpLength: MAX_DIRECT_SDP_LENGTH });
});

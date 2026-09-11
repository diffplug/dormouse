// @vitest-environment node
/**
 * The direct path over the **real** addon: two Node peers negotiating a live
 * WebRTC data channel, with `node-datachannel`'s polyfill on both ends.
 *
 * Everything else in the direct path's suites runs on the in-memory pair in
 * `remote/direct/test-fake-peer.ts`, which answers descriptions rather than
 * parsing them and opens a channel because a test said to. That is the right
 * shape for the cutover rules and the wrong one for the two questions this file
 * asks: does the shipped `RTCPeerConnection` satisfy the `DirectPeerLike` seam
 * as written, and does a real SCTP channel carry what the protocol puts on it.
 * So the SDP here is a real description of real host candidates, the channel is
 * real DTLS/SCTP, and the session riding it is the real Noise session — the
 * whole loop from `test-e2e-harness.ts`, with only the addon swapped in.
 *
 * **The addon is resolved here rather than through the shipped factory.** It is
 * installed under `standalone/sidecar`, which is where the shipped bundle finds
 * it with a bare `require`; `lib` must not depend on it, because `lib` is a
 * browser bundle root. So these cases inject a plain factory over the polyfill
 * this file resolves, and the shipped factory is driven by the last case alone.
 */

import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import {
  DIRECT_CHANNEL_LABEL,
  NOISE_MAX_MESSAGE_LENGTH,
  type TerminalDataEvent,
} from 'remote-lib-common';
import { DirectPeer, type DirectPeerLike } from '../../remote/direct/direct-peer';
import { STREAMED_CHUNK, collect, makeE2eHarness, waitFor } from '../../remote/client/test-e2e-harness';
import { createNativeDirectPeerFactory, disposeNativeDirectPeers } from './native-direct-peer';

/** The one call the reliability case needs that `DirectPeerLike` has no reason to. */
interface AddsCandidates {
  addIceCandidate(candidate: unknown): Promise<void>;
}

/** A file inside the package that declares the addon, to resolve it from. */
const sidecarRequire = createRequire(
  fileURLToPath(new URL('../../../../standalone/sidecar/package.json', import.meta.url)),
);

interface NativePolyfill {
  readonly RTCPeerConnection: new (config: { iceServers: [] }) => DirectPeerLike;
}

const { RTCPeerConnection } = sidecarRequire('node-datachannel/polyfill') as NativePolyfill;

/**
 * `iceServers: []` as both shipped factories pass it: host candidates only,
 * never a public STUN or TURN default.
 */
const buildPeer = (): DirectPeerLike => new RTCPeerConnection({ iceServers: [] });

/** Whether the last case already tore the addon down through the shipped path. */
let disposedByFactory = false;

afterAll(() => {
  // The addon runs its own threads, which outlive every peer and would hold
  // this worker open after the last assertion. One teardown, whichever path
  // reached it — both resolve the same native module.
  if (!disposedByFactory) (sidecarRequire('node-datachannel') as { cleanup: () => void }).cleanup();
});

/**
 * What one negotiation is given before it is written off. A local pair settles
 * in single-digit milliseconds; the slack is for a machine whose interfaces are
 * slow to answer, where each end waits out `DIRECT_GATHER_TIMEOUT_MS`.
 */
const ATTEMPT_BUDGET_MS = 5_000;
/** How many negotiations a case will spend before it fails; see {@link untilOpen}. */
const NEGOTIATION_ATTEMPTS = 4;
/** Every attempt, plus the ceremonies in front of them — never vitest's default. */
const CASE_BUDGET_MS = 45_000;

interface Negotiation {
  /** Whether the channel this attempt describes has come up. */
  open(): boolean;
  /** Drop this attempt's peers, so a retry does not run beside them. */
  abandon(): void;
}

/**
 * Run `start` until the channel it negotiates comes up, abandoning an attempt
 * that does not.
 *
 * **Retried on purpose.** Two agents in one process occasionally settle on a
 * candidate pair that answers ICE and then swallows DTLS — every failure
 * measured picked the same stray ULA IPv6 address, ~2% of attempts on macOS
 * 26.0, 2026-09 — and staying relayed is precisely what the protocol does about
 * that. The claim under test is that the addon carries the session when a
 * channel comes up, not that ICE never loses one, so a lost attempt is retried
 * on a fresh session rather than reported as a broken addon.
 */
async function untilOpen<T extends Negotiation>(start: () => Promise<T>, what: string): Promise<T> {
  let lost: unknown;
  for (let attempt = 1; attempt <= NEGOTIATION_ATTEMPTS; attempt += 1) {
    const run = await start();
    try {
      await waitFor(() => run.open(), what, ATTEMPT_BUDGET_MS);
      return run;
    } catch (error) {
      lost = error;
      run.abandon();
    }
  }
  throw lost;
}

/**
 * The whole loop — phone, relay, Burrow — with both ends on the native addon,
 * paired, connected, and offered a direct path.
 */
async function startConnected() {
  const clientPeers: DirectPeerLike[] = [];
  const burrowPeers: DirectPeerLike[] = [];
  const harness = await makeE2eHarness({
    deps: { createDirectPeer: collect(clientPeers, buildPeer) },
    burrowDirect: collect(burrowPeers, buildPeer),
  });
  await harness.connectPaired();
  return {
    harness,
    clientPeers,
    burrowPeers,
    open: () => harness.client.transportPath === 'direct',
    abandon: () => {
      for (const peer of [...clientPeers, ...burrowPeers]) peer.close();
    },
  };
}

const connectedDirect = () => untilOpen(startConnected, 'the session to go direct');

/** As much of `RTCDataChannel` as the reliability probe reads off either end. */
interface ChannelFacts {
  readonly label: string;
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
}

/**
 * One negotiation whose offerer asks for everything a Noise stream cannot ride,
 * so the answerer's view of the channel can be compared against it.
 *
 * Unlike a browser, this stack raises `datachannel` when the association
 * carries the channel rather than when the offer describes it, so the whole
 * negotiation has to complete — which is why it goes through
 * {@link untilOpen} like every other one here.
 */
async function startReliabilityProbe() {
  const offerer = buildPeer();
  const answerer = buildPeer();
  let adopted: ChannelFacts | null = null;
  answerer.addEventListener('datachannel', (ev) => {
    adopted = (ev as { channel: ChannelFacts }).channel;
  });
  for (const [from, to] of [
    [offerer, answerer],
    [answerer, offerer],
  ] as const) {
    from.addEventListener('icecandidate', (ev) => {
      const candidate = (ev as { candidate?: unknown }).candidate;
      if (candidate) void (to as unknown as AddsCandidates).addIceCandidate(candidate);
    });
  }
  const asked = offerer.createDataChannel(DIRECT_CHANNEL_LABEL, {
    ordered: false,
    maxRetransmits: 0,
  } as { ordered?: boolean }) as unknown as ChannelFacts;
  const offer = await offerer.createOffer();
  await offerer.setLocalDescription(offer);
  await answerer.setRemoteDescription(offerer.localDescription!);
  const answer = await answerer.createAnswer();
  await answerer.setLocalDescription(answer);
  await offerer.setRemoteDescription(answerer.localDescription!);
  return {
    asked,
    get adopted() {
      return adopted;
    },
    open: () => adopted !== null,
    abandon: () => {
      offerer.close();
      answerer.close();
    },
  };
}

describe('the direct path over the native addon', () => {
  it(
    'negotiates a channel and carries protocol-v1 on it, the relay silent after',
    async () => {
      const run = await connectedDirect();
      const { harness } = run;

      expect(run.clientPeers).toHaveLength(1);
      expect(run.burrowPeers).toHaveLength(1);
      expect(harness.client.transportPath).toBe('direct');
      // The two facts `DirectPeer` reads off a real connection before it lets a
      // session ride one: the association's own per-message limit, and that the
      // seam's `sctp` really is where the polyfill reports it. A cutover
      // happened, so both were already good enough — this says which numbers.
      const sctp = run.clientPeers[0]!.sctp;
      expect(sctp).not.toBeNull();
      expect(sctp!.maxMessageSize).toBeGreaterThanOrEqual(NOISE_MAX_MESSAGE_LENGTH);
      // Three Client→Burrow transport frames on this connection: the connection
      // request the ceremony ended with, the offer, and the switch. Three back:
      // the outcome, the answer, and the Burrow's own switch. The SDPs crossed
      // inside the session, so the Relay saw only padded control bodies.
      expect(harness.clientTransportFrames()).toHaveLength(3);
      expect(harness.burrowTransportFrames()).toHaveLength(3);

      const clientBefore = harness.clientTransportFrames().length;
      const burrowBefore = harness.burrowTransportFrames().length;
      const chunks: TerminalDataEvent[] = [];

      expect(await harness.client.hello()).toMatchObject({ protocolVersion: 1 });
      await harness.client.watchDirectory(() => {});
      await harness.client.attach('surface-1', 80, 24, { onData: (e) => chunks.push(e) });
      await harness.client.write('surface-1', 'ls\n');

      // Requests, answers, and the burrow→client stream all crossed the channel;
      // the relay carried none of it, in either direction.
      expect(harness.clientTransportFrames()).toHaveLength(clientBefore);
      expect(harness.burrowTransportFrames()).toHaveLength(burrowBefore);
      expect(chunks).toEqual([STREAMED_CHUNK]);
    },
    CASE_BUDGET_MS,
  );

  /**
   * The bound the protocol actually needs from the channel. One channel frame
   * is one Noise transport message, so a real SCTP association has to carry
   * `NOISE_MAX_MESSAGE_LENGTH` bytes in a single message — well past the 16 KB
   * a data channel fragments at without a negotiated maximum, and the one
   * property the in-memory pair cannot say anything about.
   *
   * Driven as a bare pair rather than through a session: what is being measured
   * is the bytes, and a Noise message that large is not something the shipped
   * protocol-v1 has a request for.
   */
  it(
    'carries a full-size Noise transport message in one frame, intact',
    async () => {
      const run = await untilOpen(async () => {
        let opened = 0;
        const inbound: Uint8Array[] = [];
        const lost: string[] = [];
        const handlers = (onFrame: (frame: Uint8Array) => void) => ({
          onOpen: () => (opened += 1),
          onFrame,
          onClosed: (reason: string) => lost.push(reason),
          onViolation: (reason: string) => lost.push(reason),
        });
        const offerer = new DirectPeer({ peer: buildPeer(), handlers: handlers(() => {}) });
        const answerer = new DirectPeer({
          peer: buildPeer(),
          handlers: handlers((frame) => inbound.push(frame)),
        });
        const offer = await offerer.offer();
        expect(offer).not.toBeNull();
        const answer = await answerer.answer(offer!);
        expect(answer).not.toBeNull();
        await offerer.acceptAnswer(answer!);
        return {
          offerer,
          answerer,
          inbound,
          lost,
          open: () => opened === 2,
          abandon: () => {
            offerer.close();
            answerer.close();
          },
        };
      }, 'both ends of the channel to open');

      try {
        const payload = new Uint8Array(NOISE_MAX_MESSAGE_LENGTH);
        crypto.getRandomValues(payload);
        run.offerer.send(payload);

        await waitFor(() => run.inbound.length === 1, 'the frame to arrive', ATTEMPT_BUDGET_MS);
        expect(run.inbound[0]).toEqual(payload);
        expect(run.lost).toEqual([]);
      } finally {
        run.abandon();
      }
    },
    CASE_BUDGET_MS,
  );

  /**
   * The channel is the session once both ends have switched, so losing it is
   * losing the Burrow — there is no relay left to fall back to.
   */
  it(
    'ends the session at both ends when the Burrow closes its peer',
    async () => {
      const run = await connectedDirect();
      const gone = vi.fn();
      run.harness.client.setOnBurrowGone(gone);

      run.burrowPeers[0]!.close();

      await waitFor(
        () => run.harness.burrow.establishedSessionCount === 0,
        'the Burrow to drop the session',
        ATTEMPT_BUDGET_MS,
      );
      await waitFor(
        () => run.harness.client.connectedBurrowId === null,
        'the phone to report the Burrow gone',
        ATTEMPT_BUDGET_MS,
      );
      expect(gone).toHaveBeenCalledOnce();
    },
    CASE_BUDGET_MS,
  );

  /**
   * The shipped factory, last because its teardown is the process's.
   *
   * **A teardown is terminal**: the native threads are gone, so a peer built on
   * them is not one this process can use and every later offer declines,
   * leaving that session relayed. The other half of the contract — a load that
   * fails warns once and declines from then on — is not drivable here: vitest's
   * `require` resolves from inside the store, where every workspace package is
   * reachable, so the addon cannot be made to not load without replacing the
   * module system this case exists to exercise.
   */
  /**
   * **What the reliability check does *not* reach on this stack.** `DirectPeer`
   * refuses a channel that is unordered or partially reliable, and the answerer
   * is the end where that could bite — it adopts a channel the peer created. A
   * browser reports the parameters the offerer actually negotiated; this
   * polyfill rebuilds every incoming channel with its own defaults, so the
   * flags never survive the crossing and only the label comparison is
   * load-bearing on a standalone Burrow.
   *
   * Pinned rather than left as prose: an addon version that starts reporting
   * them turns a documented limitation into an enforced rule, and this is what
   * says so (`docs/specs/remote-api.md` → Transport → "Direct path").
   */
  it(
    'does not carry a channel’s reliability across to the answerer',
    async () => {
      const run = await untilOpen(startReliabilityProbe, 'the answerer to adopt the channel');
      try {
        const seen = run.adopted!;
        expect(run.asked.ordered).toBe(false);
        expect(seen.label).toBe(DIRECT_CHANNEL_LABEL);
        expect(seen.ordered).toBe(true);
        expect(seen.maxRetransmits).toBeNull();
        expect(seen.maxPacketLifeTime).toBeNull();
      } finally {
        run.abandon();
      }
    },
    CASE_BUDGET_MS,
  );

  it('builds a peer through a bare require, and declines once torn down', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const factory = createNativeDirectPeerFactory();
      const peer = factory();
      expect(peer).not.toBeNull();
      peer!.close();

      disposeNativeDirectPeers();
      disposedByFactory = true;

      expect(factory()).toBeNull();
      expect(createNativeDirectPeerFactory()()).toBeNull();
      // Silent: only an installation the addon never loaded on warns, and once.
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});

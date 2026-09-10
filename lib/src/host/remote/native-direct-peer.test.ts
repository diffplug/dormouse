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
 * The addon is resolved from `standalone/sidecar`, which is where it is
 * installed and where the shipped bundle finds it; `lib` must not depend on it,
 * because `lib` is a browser bundle root.
 */

import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { NOISE_MAX_MESSAGE_LENGTH, type TerminalDataEvent } from 'remote-lib-common';
import { DirectPeer, type DirectPeerLike } from '../../remote/direct/direct-peer';
import { STREAMED_CHUNK, makeE2eHarness, waitFor } from '../../remote/client/test-e2e-harness';
import { createNativeDirectPeerFactory, disposeNativeDirectPeers } from './native-direct-peer';

/**
 * A file inside the package that declares the addon. The sidecar bundle sits
 * beside its own `node_modules` and needs no such hint; this file, running from
 * source under `lib/`, does.
 */
const SIDECAR = fileURLToPath(
  new URL('../../../../standalone/sidecar/package.json', import.meta.url),
);

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

const warnings: string[] = [];
const buildPeer = createNativeDirectPeerFactory({
  resolveFrom: SIDECAR,
  warn: (message) => warnings.push(message),
});

afterAll(() => {
  // The addon runs its own threads, which outlive every peer and would hold
  // this worker open after the last assertion.
  disposeNativeDirectPeers();
});

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

/** Build a peer, keeping it so a case can close the far end by hand. */
function collect(into: DirectPeerLike[]): () => DirectPeerLike | null {
  return () => {
    const peer = buildPeer();
    if (peer) into.push(peer);
    return peer;
  };
}

/**
 * The whole loop — phone, relay, Burrow — with both ends on the native addon,
 * paired, connected, and offered a direct path.
 */
async function startConnected() {
  const clientPeers: DirectPeerLike[] = [];
  const burrowPeers: DirectPeerLike[] = [];
  const harness = await makeE2eHarness({
    deps: { createDirectPeer: collect(clientPeers) },
    burrowDirect: collect(burrowPeers),
  });
  await harness.pairAndApprove(await harness.mintInvitation());
  expect(await harness.client.connect(harness.burrowId)).toMatchObject({ ok: true });

  const transportFrames = (frames: Array<Record<string, unknown>>) =>
    frames.filter((frame) => frame.kind === 'connection' && frame.step === 'transport');
  return {
    harness,
    clientPeers,
    burrowPeers,
    /** Client→relay transport frames on the connection, which stop at the switch. */
    clientFrames: () => transportFrames(harness.clientSocket().frames('e2e')),
    /** Burrow→relay transport frames on the connection, which stop at its own switch. */
    burrowFrames: () => transportFrames(harness.relay.burrowSocket.frames('e2e')),
    open: () => harness.client.transportPath === 'direct',
    abandon: () => {
      for (const peer of [...clientPeers, ...burrowPeers]) peer.close();
    },
  };
}

const connectedDirect = () => untilOpen(startConnected, 'the session to go direct');

describe('the direct path over the native addon', () => {
  it(
    'negotiates a channel and carries protocol-v1 on it, the relay silent after',
    async () => {
      const run = await connectedDirect();

      // Both ends built a peer, and nothing warned — a machine that cannot load
      // the addon would have declined and stayed relayed instead.
      expect(warnings).toEqual([]);
      expect(run.clientPeers).toHaveLength(1);
      expect(run.burrowPeers).toHaveLength(1);
      expect(run.harness.client.transportPath).toBe('direct');
      // Three Client→Burrow transport frames on this connection: the connection
      // request the ceremony ended with, the offer, and the switch. Three back:
      // the outcome, the answer, and the Burrow's own switch. The SDPs crossed
      // inside the session, so the Relay saw only padded control bodies.
      expect(run.clientFrames()).toHaveLength(3);
      expect(run.burrowFrames()).toHaveLength(3);

      const clientBefore = run.clientFrames().length;
      const burrowBefore = run.burrowFrames().length;
      const chunks: TerminalDataEvent[] = [];

      expect(await run.harness.client.hello()).toMatchObject({ protocolVersion: 1 });
      await run.harness.client.watchDirectory(() => {});
      await run.harness.client.attach('surface-1', 80, 24, { onData: (e) => chunks.push(e) });
      await run.harness.client.write('surface-1', 'ls\n');

      // Requests, answers, and the burrow→client stream all crossed the channel;
      // the relay carried none of it, in either direction.
      expect(run.clientFrames()).toHaveLength(clientBefore);
      expect(run.burrowFrames()).toHaveLength(burrowBefore);
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
        const offererPeer = buildPeer();
        const answererPeer = buildPeer();
        expect(offererPeer).not.toBeNull();
        expect(answererPeer).not.toBeNull();
        const offerer = new DirectPeer({ peer: offererPeer!, handlers: handlers(() => {}) });
        const answerer = new DirectPeer({
          peer: answererPeer!,
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
});

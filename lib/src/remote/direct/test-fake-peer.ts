/**
 * Two {@link DirectPeerLike}s linked in memory, as the direct path's tests drive
 * them.
 *
 * Test-only, and shared for the reason `../test-relay.ts` is: the Client and the
 * Burrow both negotiate against *the same* idea of what a peer connection does,
 * and two private copies would be two opinions about when a channel opens.
 * Nothing here is a `RTCPeerConnection` — it answers descriptions, links the one
 * data channel, and delivers frames in order — which is exactly the surface
 * `direct-peer.ts` declares, so a case that passes here exercises the shipped
 * wrapper rather than a stub of it.
 *
 * **The one thing it deliberately cannot do is reorder against the relay.** A
 * channel frame overtaking the peer's `direct-switch` is a race between two
 * transports, and the in-memory relay delivers synchronously; the knob for it is
 * `TestRelay.holdToClient()`, on the side that is actually slow.
 */

import { DIRECT_CHANNEL_LABEL, NOISE_MAX_MESSAGE_LENGTH } from 'remote-lib-common';
import {
  type DirectChannelLike,
  type DirectPathPolicy,
  type DirectPeerLike,
  type DirectSctpLike,
  type DirectSelectedPair,
  type DirectSessionDescription,
} from './direct-peer';
import { FakeEventTarget } from '../test-fake-socket';

/** When the linked channel reports itself open. */
export type FakeChannelOpening =
  /** As soon as the offerer has accepted the answer, on a microtask. */
  | 'auto'
  /** Only when {@link FakeDirectNetwork.openChannels} is called. */
  | 'manual'
  /** Never — what a peer behind a symmetric NAT looks like from here. */
  | 'never';

export interface FakeDirectNetworkOptions {
  readonly opening?: FakeChannelOpening;
  /**
   * Leave `iceGatheringState` at `gathering` until the case completes it, with
   * no candidate gathered but those the case gathers
   * ({@link FakePeer.gatherCandidate}), so the wrapper falls back on its own
   * gathering deadlines instead of an event. `complete`, the default, starts
   * each end done, with its one host candidate.
   */
  readonly gathering?: 'complete' | 'pending';
  /** Which side describes itself with an SDP over the signal's bound. */
  readonly oversize?: 'offer' | 'answer';
  /**
   * What the association reports as its per-message limit, for the case where
   * it is too small to carry one Noise transport message. `null` models an
   * implementation that reports no association at all.
   */
  readonly maxMessageSize?: number | null;
  /** A channel a Noise stream cannot ride; see {@link ChannelDefect}. */
  readonly channel?: ChannelDefect;
  /**
   * Which end's channel carries that defect; both by default. The answerer is
   * the end where the check can fail in production — it validates a channel the
   * *peer* created, while the offerer only re-reads its own request.
   */
  readonly channelSide?: FakePeerRole;
  /**
   * What each end's transport first reports as its selected pair, as the
   * answerer sees it: {@link FAKE_LAN_PAIR} by default, `null` for none.
   */
  readonly selectedPair?: DirectSelectedPair | null;
}

/** The pair a run selects unless it says otherwise: both ends on one LAN. */
export const FAKE_LAN_PAIR: DirectSelectedPair = { local: '192.168.1.2', remote: '192.168.1.3' };

/** A pair whose phone end is off that LAN, which {@link lanOnlyPolicy} refuses as the remote end's. */
export const OFF_LAN_PAIR: DirectSelectedPair = { local: '192.168.1.2', remote: '10.0.0.3' };

/** The one host candidate each end describes itself with: its half of {@link FAKE_LAN_PAIR}. */
const HOST_CANDIDATE: Record<FakePeerRole, string> = {
  answerer: FAKE_LAN_PAIR.local!,
  offerer: FAKE_LAN_PAIR.remote!,
};

/** The public address a srflx reports unless a case names another (TEST-NET-3, RFC 5737). */
const SRFLX_ADDRESS = '203.0.113.7';

/** The kinds of candidate a case can have an end gather. */
export type FakeCandidateType = 'host' | 'srflx';

/**
 * How a stack spells the string an `icecandidate` event carries. Its SDP line is
 * `a=candidate:…` either way.
 */
export type FakeCandidateForm =
  /** A browser's: the line without its `a=`. */
  | 'browser'
  /** `node-datachannel`'s polyfill: the line itself. */
  | 'polyfill';

/** What {@link FakePeer.gatherCandidate} gathers, past its type. */
export interface FakeCandidate {
  /**
   * Its address, an IPv6 one for a second family: by default this end's host
   * address, or {@link SRFLX_ADDRESS} for a srflx.
   */
  readonly address?: string;
  /** How its `icecandidate` string is spelled; a browser's by default. */
  readonly form?: FakeCandidateForm;
}

/** One candidate as its SDP line, `a=candidate:…`. */
function candidateLine(address: string, type: FakeCandidateType): string {
  const related = type === 'srflx' ? ` raddr ${address.includes(':') ? '::' : '0.0.0.0'} rport 0` : '';
  return `a=candidate:1 1 udp 2130706431 ${address} 9 typ ${type}${related}`;
}

/**
 * A path policy allowing only {@link FAKE_LAN_PAIR}'s LAN, by string prefix —
 * the address math is the host's, and `lib/src/host/remote/local-networks.test.ts`
 * pins it — recording every pair it is asked about. It binds nothing, passes
 * both descriptions through as given, and reads no address out of an offer,
 * unless `over` says otherwise.
 */
export function lanOnlyPolicy(
  over: Partial<Pick<DirectPathPolicy, 'describe' | 'acceptRemote' | 'reportedAddress'>> = {},
): DirectPathPolicy & { readonly asked: Array<DirectSelectedPair | null> } {
  const asked: Array<DirectSelectedPair | null> = [];
  const onLan = (address: string | null) => address?.startsWith('192.168.1.') ?? false;
  return {
    asked,
    bindAddress: () => null,
    describe: (sdp) => sdp,
    acceptRemote: (sdp) => sdp,
    reportedAddress: () => null,
    ...over,
    // This end first, as the host's policy reads it.
    refusal: (pair) => {
      asked.push(pair);
      if (!pair) return { reason: 'off the LAN', end: null };
      if (!onLan(pair.local)) return { reason: 'off the LAN', end: 'local' };
      return onLan(pair.remote) ? null : { reason: 'off the LAN', end: 'remote' };
    },
  };
}

/** One end of the linked pair; the offerer creates the channel. */
export type FakePeerRole = 'offerer' | 'answerer';

/** One way a channel can be something a Noise stream cannot ride. */
export type ChannelDefect = 'unordered' | 'lossy' | 'expiring' | 'mislabeled';

/**
 * Let this file's queued microtasks run: every fake channel event is delivered
 * through `queueMicrotask`, so a case that has just opened or sent needs one
 * turn of the loop before it can read what happened.
 */
export const flushMicrotasks = (): Promise<unknown> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * A peer factory that keeps what it builds, so a case can close or inspect the
 * far end by hand. Both ends of a session get their own array.
 */
export function collect<T>(into: T[], build: () => T): () => T {
  return () => {
    const peer = build();
    into.push(peer);
    return peer;
  };
}

export class FakeDirectNetwork {
  readonly #options: FakeDirectNetworkOptions;
  readonly #peers = new Map<FakePeerRole, FakePeer>();
  #offererChannel: FakeChannel | null = null;
  #answererChannel: FakeChannel | null = null;

  constructor(options: FakeDirectNetworkOptions = {}) {
    this.#options = options;
  }

  /** The Client's side: it creates the channel and describes it first. */
  createOfferer(): FakePeer {
    return this.#create('offerer');
  }

  /** The Burrow's side: it learns of the channel through `datachannel`. */
  createAnswerer(): FakePeer {
    return this.#create('answerer');
  }

  get offererChannel(): FakeChannel | null {
    return this.#offererChannel;
  }

  get answererChannel(): FakeChannel | null {
    return this.#answererChannel;
  }

  /** Both ends report open, in the order a linked pair would settle. */
  openChannels(): void {
    this.#offererChannel?.open();
    this.#answererChannel?.open();
  }

  /** The channel goes away under a live session — a radio gap, a peer that quit. */
  dropChannels(): void {
    this.#offererChannel?.drop();
    this.#answererChannel?.drop();
  }

  /** Let both peers finish gathering, for a run constructed with `pending`. */
  completeGathering(): void {
    for (const peer of this.#peers.values()) peer.completeGathering();
  }

  #create(role: FakePeerRole): FakePeer {
    const peer = new FakePeer(role, this.#options, this);
    this.#peers.set(role, peer);
    return peer;
  }

  /** Called by a peer that has just created or received the channel. */
  registerChannel(role: FakePeerRole, channel: FakeChannel): void {
    if (role === 'offerer') this.#offererChannel = channel;
    else this.#answererChannel = channel;
    const offerer = this.#offererChannel;
    const answerer = this.#answererChannel;
    if (offerer && answerer) {
      offerer.link(answerer);
      answerer.link(offerer);
    }
  }

  /** The offerer accepted the answer: the negotiation is complete. */
  negotiated(): void {
    if ((this.#options.opening ?? 'auto') !== 'auto') return;
    queueMicrotask(() => this.openChannels());
  }
}

/**
 * One end of the pair. Descriptions are plausible rather than parsed: nothing
 * reads them but the signal guard and the gathering wait, and the pairing is
 * done by the network.
 */
export class FakePeer implements DirectPeerLike {
  readonly #role: FakePeerRole;
  readonly #options: FakeDirectNetworkOptions;
  readonly #network: FakeDirectNetwork;
  readonly #events = new FakeEventTarget();
  #local: DirectSessionDescription | null = null;
  /** Every candidate this end has gathered, as the SDP lines its local description carries. */
  readonly #gathered: string[] = [];
  /** What {@link gatherWithRemoteOffer} queued for the next offer this end is handed. */
  readonly #gatherOnOffer: Array<[FakeCandidateType, FakeCandidate]> = [];
  /** The peer's description as this end was handed it. */
  remoteDescription: DirectSessionDescription | null = null;
  #gathering: string;
  #connectionState = 'connecting';
  closed = false;
  /**
   * What the transport's `getSelectedCandidatePair()` reports, as addresses;
   * `null` for none. See {@link FakeDirectNetworkOptions.selectedPair}.
   */
  selectedPair: DirectSelectedPair | null;

  constructor(
    role: FakePeerRole,
    options: FakeDirectNetworkOptions,
    network: FakeDirectNetwork,
  ) {
    this.#role = role;
    this.#options = options;
    this.#network = network;
    this.#gathering = options.gathering === 'pending' ? 'gathering' : 'complete';
    // One host candidate, whatever pair ICE goes on to select: a description is
    // a claim, never the path. A pending end has gathered nothing yet, and gets
    // its candidates from the case.
    if (this.#gathering === 'complete') this.#gathered.push(candidateLine(HOST_CANDIDATE[role], 'host'));
    this.selectedPair = options.selectedPair === undefined ? FAKE_LAN_PAIR : options.selectedPair;
  }

  get iceGatheringState(): string {
    return this.#gathering;
  }

  /**
   * As a real stack's does, it carries every candidate gathered so far, those
   * gathered before it was set included.
   */
  get localDescription(): DirectSessionDescription | null {
    const local = this.#local;
    if (!local) return null;
    const gathered = this.#gathered.map((line) => `${line}\r\n`).join('');
    return { ...local, sdp: `${local.sdp ?? ''}${gathered}` };
  }

  get sctp(): DirectSctpLike | null {
    const limit = this.#options.maxMessageSize;
    if (limit === null) return null;
    const pair = this.selectedPair;
    const candidate = (address: string | null) => ({ address });
    return {
      maxMessageSize: limit ?? NOISE_MAX_MESSAGE_LENGTH,
      transport: {
        iceTransport: {
          getSelectedCandidatePair: () =>
            pair && { local: candidate(pair.local), remote: candidate(pair.remote) },
        },
      },
    };
  }

  get connectionState(): string {
    return this.#connectionState;
  }

  /** Move the connection, firing the event a real one does. */
  setConnectionState(state: string): void {
    this.#connectionState = state;
    this.#emit('connectionstatechange', {});
  }

  /**
   * ICE moves the connection onto another pair and says so with an ICE state
   * change; a move it reports to no one is a plain {@link selectedPair} write.
   */
  reselect(pair: DirectSelectedPair | null): void {
    this.selectedPair = pair;
    this.#emit('iceconnectionstatechange', {});
  }

  /** This end's channel defect, if the run put one on this side. */
  get #defect(): ChannelDefect | undefined {
    const { channel, channelSide } = this.#options;
    return !channelSide || channelSide === this.#role ? channel : undefined;
  }

  createDataChannel(label: string): DirectChannelLike {
    const channel = new FakeChannel(label, this.#defect);
    this.#network.registerChannel(this.#role, channel);
    return channel;
  }

  async createOffer(): Promise<DirectSessionDescription> {
    return { type: 'offer', sdp: this.#describe('offer') };
  }

  async createAnswer(): Promise<DirectSessionDescription> {
    return { type: 'answer', sdp: this.#describe('answer') };
  }

  async setLocalDescription(description: DirectSessionDescription): Promise<void> {
    this.#local = description;
  }

  async setRemoteDescription(description: DirectSessionDescription): Promise<void> {
    this.remoteDescription = description;
    if (description.type === 'offer') {
      // The answerer learns of the channel here, exactly as a real one does.
      const channel = new FakeChannel(DIRECT_CHANNEL_LABEL, this.#defect);
      this.#network.registerChannel(this.#role, channel);
      this.#emit('datachannel', { channel });
      for (const [type, candidate] of this.#gatherOnOffer.splice(0)) this.gatherCandidate(type, candidate);
      return;
    }
    this.#network.negotiated();
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    this.#events.addEventListener(type, handler);
  }

  close(): void {
    this.closed = true;
  }

  /** Finish gathering late, for the run that starts `pending`. */
  completeGathering(): void {
    if (this.#gathering === 'complete') return;
    this.#gathering = 'complete';
    this.#emit('icegatheringstatechange', {});
  }

  /**
   * Gather one candidate: into the local description, then reported through
   * `icecandidate`, in that order as both shipped stacks do it. `null` reports
   * end-of-candidates. A stack reports each candidate once, so a second of the
   * same throws.
   */
  gatherCandidate(type: FakeCandidateType | null, candidate: FakeCandidate = {}): void {
    if (type === null) {
      this.#emit('icecandidate', { candidate: null });
      return;
    }
    const address = candidate.address ?? (type === 'srflx' ? SRFLX_ADDRESS : HOST_CANDIDATE[this.#role]);
    const line = candidateLine(address, type);
    if (this.#gathered.includes(line)) throw new Error(`${line} is already gathered`);
    this.#gathered.push(line);
    const reported = (candidate.form ?? 'browser') === 'browser' ? line.slice('a='.length) : line;
    this.#emit('icecandidate', { candidate: { candidate: reported } });
  }

  /**
   * Gather one candidate from inside the next `setRemoteDescription` of an
   * offer, before this end has a description of its own — where an answerer's
   * stack starts gathering, so the `icecandidate` fires before any wait exists.
   */
  gatherWithRemoteOffer(type: FakeCandidateType, candidate: FakeCandidate = {}): void {
    this.#gatherOnOffer.push([type, candidate]);
  }

  #describe(kind: 'offer' | 'answer'): string {
    // Its candidates are the gathered ones, which `localDescription` appends.
    const body =
      'v=0\r\no=- 1 2 IN IP4 127.0.0.1\r\ns=-\r\nt=0 0\r\n' +
      'm=application 9 UDP/DTLS/SCTP webrtc-datachannel\r\nc=IN IP4 0.0.0.0\r\n' +
      `a=setup:${kind === 'offer' ? 'actpass' : 'active'}\r\na=mid:0\r\na=sctp-port:5000\r\n`;
    // A machine with many interfaces describes itself in more candidates than a
    // signal can carry; the attempt is skipped or declined rather than sent.
    return this.#options.oversize === kind ? `${body}a=x:${'c'.repeat(4000)}\r\n` : body;
  }

  #emit(type: string, ev: unknown): void {
    this.#events.emit(type, ev);
  }
}

/** One end of the linked data channel. */
export class FakeChannel implements DirectChannelLike {
  readonly label: string;
  binaryType = 'blob';
  readyState = 'connecting';
  /** The three reliability facts `DirectPeer` checks before it adopts one. */
  readonly ordered: boolean;
  readonly maxRetransmits: number | null;
  readonly maxPacketLifeTime: number | null;
  /**
   * What the implementation is still holding. Sends do not move it — a case
   * that wants a busy channel sets it, then calls {@link drained} to model the
   * association catching up.
   */
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  /** Every frame this end was asked to send, in order. */
  readonly sent: Uint8Array[] = [];
  #peer: FakeChannel | null = null;
  /** Frames delivered before this end opened, held as a real one would. */
  readonly #inbox: Uint8Array[] = [];
  readonly #events = new FakeEventTarget();

  constructor(label: string, defect?: ChannelDefect) {
    this.label = defect === 'mislabeled' ? `${label}-other` : label;
    this.ordered = defect !== 'unordered';
    this.maxRetransmits = defect === 'lossy' ? 3 : null;
    this.maxPacketLifeTime = defect === 'expiring' ? 500 : null;
  }

  /** The association caught up: drop to the low-water mark and wake the sender. */
  drained(): void {
    this.bufferedAmount = 0;
    this.#events.emit('bufferedamountlow', {});
  }

  link(peer: FakeChannel): void {
    this.#peer = peer;
  }

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    this.#events.addEventListener(type, handler);
  }

  send(data: ArrayBuffer | ArrayBufferView): void {
    if (this.readyState !== 'open') throw new Error('the channel is not open');
    // Copied on the way out, so what a case reads back is what was sent rather
    // than whatever the caller's buffer holds by the time it looks.
    const bytes = ArrayBuffer.isView(data)
      ? new Uint8Array(data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength))
      : new Uint8Array(data.slice(0));
    this.sent.push(bytes);
    const peer = this.#peer;
    if (!peer) return;
    // A microtask, so ordering is the queue's rather than the caller's stack.
    queueMicrotask(() => peer.deliver(bytes));
  }

  close(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    // The far end learns of it, as it does over a real SCTP association — on a
    // task rather than in this stack, since the network is between them.
    queueMicrotask(() => this.#peer?.drop());
  }

  open(): void {
    if (this.readyState !== 'connecting') return;
    this.readyState = 'open';
    this.#emit('open', {});
    for (const frame of this.#inbox.splice(0)) this.deliver(frame);
  }

  /** The channel dies under a live session: closed, with an event. */
  drop(): void {
    if (this.readyState === 'closed') return;
    this.readyState = 'closed';
    this.#emit('close', {});
  }

  /** One frame from the far end, held until this end is open. */
  deliver(frame: Uint8Array): void {
    if (this.readyState === 'connecting') {
      this.#inbox.push(frame);
      return;
    }
    if (this.readyState !== 'open') return;
    this.receiveRaw(frame.slice().buffer);
  }

  /** Deliver whatever a peer speaking another protocol would put on the wire. */
  receiveRaw(data: unknown): void {
    this.#emit('message', { data });
  }

  #emit(type: string, ev: unknown): void {
    this.#events.emit(type, ev);
  }
}

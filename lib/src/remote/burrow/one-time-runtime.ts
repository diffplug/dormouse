/**
 * The laptop's half of a one-time connection (`docs/specs/one-time.md` ->
 * "Burrow runtime"): one rendezvous socket, one one-use keypair, one phone, and
 * at most one session, which runs over the direct path or not at all.
 *
 * **The link and two typed digits are the whole authorization, and it writes
 * nothing** (`docs/specs/remote-security-model.md` -> "One-time connection"):
 * no ACL record, no presence proof, no enrollment, nothing a phone could keep.
 * This module imports nothing that could, and `scripts/e2e-lint.mjs` holds that
 * textually. The socket and the remote-api session are injected, keeping it
 * environment-free, so both Burrow hosts run the same one.
 *
 * **Single-use.** A runtime opens once and ends once; nothing resumes, and a new
 * link is a new runtime.
 */

import {
  E2E_INIT_BURST,
  E2E_INIT_REFILL_INTERVAL_MS,
  MAX_ONE_TIME_FORWARDED,
  NoiseError,
  NoiseTransportSession,
  ONE_TIME_LINK_TTL_MS,
  RELAY_PONG,
  ONE_TIME_WS_ROUTES,
  TokenBucket,
  WS_CLOSE_ONE_TIME_DEADLINE,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_PEER_GONE,
  WS_CLOSE_ONE_TIME_VIOLATION,
  boundedBurrowLabel,
  constantTimeEqual,
  createNoiseResponder,
  formatOneTimeLinkUrl,
  fromBase64Url,
  generateNoiseKeyPair,
  isOneTimeClientFrame,
  isOneTimeRequestV1,
  isOneTimeRoomFrame,
  knownOneTimeDeviceLabel,
  oneTimeLinkExpired,
  oneTimeLinkPrologue,
  toBase64Url,
  utf8Encode,
  type DirectPath,
  type NoiseKeyPair,
  type OneTimeBurrowFrame,
  type OneTimeClientFrame,
  type OneTimeDenialCode,
  type OneTimeDeviceLabel,
  type OneTimeLink,
  type OneTimeOutcomeV1,
  type OneTimeRoomFrame,
  type TransportReceipt,
} from 'remote-lib-common';

import type { DirectPeering } from '../direct/direct-peer';
import type { PathRefusal } from '../direct/path-refusal';
import { parseOneTimeFrame, RendezvousHold } from '../one-time-rendezvous';
import { closeCode, realTimer, type RemoteTimer, type RemoteWebSocket } from '../ws';
import {
  EstablishedE2eSession,
  sealControl,
  type DirectOnlyBreak,
  type RemoteApiSessionContext,
  type RemoteApiSessionLike,
} from './established-session';

/** How long {@link OneTimeRuntime.open} waits for the room to announce itself. */
export const ONE_TIME_OPEN_TIMEOUT_MS = 8_000;

/**
 * Why a one-time connection ended, as the laptop's panel words it. A closed set
 * this runtime picks locally, and fixed copy per member — never text off the
 * wire.
 */
export type OneTimeEndReason =
  /** The laptop's End or Cancel, or its service shutting down. */
  | 'user-ended'
  /** The person at the laptop denied the request. */
  | 'user-denied'
  /** The person at the laptop typed digits the phone was not showing. */
  | 'confirmation-mismatch'
  /** The link expired unused, the confirmation came too late, or the room's deadline passed. */
  | 'expired'
  /** The phone's socket closed before the switch, or the channel after it. */
  | 'phone-left'
  /**
   * No direct path: declined, abandoned, or not switched by
   * `DIRECT_ONLY_DEADLINE_MS` — or any fatal session failure before the switch,
   * a failed decrypt included, since `onFatal` carries no cause to tell them apart.
   */
  | 'direct-failed'
  /** The path ended a session held to the allowed networks, before the switch or after: its `refusal` says how. */
  | 'network-not-allowed'
  /** The session went `ESTABLISHED_E2E_IDLE_TIMEOUT_MS` without a word from the phone. */
  | 'idle'
  /** The rendezvous never announced a room. */
  | 'unreachable'
  /** The rendezvous closed before the switch, for no reason it named. */
  | 'rendezvous-lost'
  /** A protocol violation, from the phone or the room, or a local failure. */
  | 'burrow-error';

/**
 * Why the service offers no one-time connection at all. The service's to
 * decide, never this runtime's: a runtime exists only in a build with a Hosted
 * origin, under a network policy that allows one (`idleOneTimeState` in
 * `lib/src/host/remote/service-protocol.ts`). `self-host`: a self-host build,
 * which reaches no rendezvous. `network-off`: the policy is Nothing
 * (`docs/specs/remote-network.md` -> "Policy").
 */
export type OneTimeUnavailableReason = 'self-host' | 'network-off';

/**
 * What the one-time connection is doing, as the laptop's panel renders it.
 * `unavailable` and `idle` are the service's; a runtime moves through the rest,
 * in order, and every path ends at `ended`.
 */
export type OneTimeState =
  | { readonly status: 'unavailable'; readonly reason: OneTimeUnavailableReason }
  | { readonly status: 'idle' }
  | { readonly status: 'opening' }
  /** The link is on screen; `expiresAt` is the last epoch ms at which it is live. */
  | { readonly status: 'waiting'; readonly url: string; readonly expiresAt: number }
  | { readonly status: 'confirming'; readonly label: string; readonly expiresAt: number }
  | { readonly status: 'connecting'; readonly label: string }
  | { readonly status: 'connected'; readonly label: string; readonly since: number }
  /** `refusal` is `network-not-allowed`'s, and only its (`EstablishedE2eSession.pathRefusal`). */
  | { readonly status: 'ended'; readonly reason: OneTimeEndReason; readonly refusal?: PathRefusal };

/**
 * One request surfaced for local approval. **The expected code is not here**:
 * the person types what the phone shows, and the runtime compares.
 */
export interface OneTimeApprovalRequest {
  /** The device, as a member of the closed set whatever the phone sent. */
  readonly label: OneTimeDeviceLabel;
  readonly requestedAt: number;
  /** Confirm with the digits the phone is showing: **exactly one attempt**. */
  approve(code: string): void;
  /** Deny locally. */
  deny(): void;
}

export interface OneTimeRuntimeOptions {
  /**
   * The rendezvous origin, `https://` or loopback `http://`, with no path. Its
   * socket route and the link's page both hang off it. **Never webview input**:
   * the service passes its baked origin.
   */
  readonly origin: string;
  /**
   * Open the Burrow route. **The socket must send no `Origin` header** — the
   * route refuses one, so no browser page can mint a room — which is why the host
   * builds it rather than this module reaching for a global.
   */
  createWebSocket(url: string): RemoteWebSocket;
  /**
   * Build the remote-api handler for the one authorized session. `burrowId` is
   * the room id, which is what `hello` answers with: this connection has no
   * enrollment to name. Its `end` is this runtime's End.
   */
  createSession(opts: RemoteApiSessionContext): RemoteApiSessionLike;
  /**
   * How this host takes the direct path: with no factory every offer is
   * declined, and the connection ends `direct-failed`; under a path policy —
   * Local networks, the allowed networks (`docs/specs/remote-network.md` ->
   * "Local networks") — a session the path ended ends `network-not-allowed`.
   */
  readonly directPeering: DirectPeering;
  /**
   * The path ended the session ({@link OneTimeState}'s `refusal`), reported as
   * the paired Burrow reports its own (`BurrowOptions.onPathRefused`).
   */
  onPathRefused?(refusal: PathRefusal): void;
  /** This machine's name, as the phone shows it; bounded here before it is sent. */
  readonly burrowLabel: string;
  /** Surface the request for local approval. */
  requestApproval(request: OneTimeApprovalRequest): void;
  /** Dismiss it, however the request ended. */
  dismissApproval(): void;
  /** Every state this runtime moves to, in order. */
  onChange(state: OneTimeState): void;
  readonly now?: () => number;
  /** Every deadline and ping this runtime arms, and the direct path's; see {@link RemoteTimer}. */
  readonly setTimer?: RemoteTimer;
}

/** A phone whose IK handshake and Split completed: the link is reserved for it. */
interface ReservedPhone {
  readonly session: NoiseTransportSession;
  /** Set once its first control message parsed; until then there is nothing to confirm. */
  request: { readonly code: string; readonly label: OneTimeDeviceLabel } | null;
  /** **Exactly one attempt**: set before anything else an approval does. */
  attempted: boolean;
}

/**
 * One unit of rendezvous work, in arrival order. The socket's close rides the
 * same FIFO as its frames, so a phone's `direct-switch` and the room's report
 * that the phone then left are read in the order they were sent.
 */
type RendezvousWork =
  | { readonly kind: 'frame'; readonly frame: OneTimeClientFrame }
  | { readonly kind: 'closed'; readonly code: number | undefined };

/**
 * The endings this laptop chose while the session's cipher is healthy, which
 * the phone is told of with the goodbye (`EstablishedE2eSession.end`) — a
 * refused path's carrying why. Every other ending is the phone's own, a path
 * that never formed, or a failure with nothing sound left to say it on.
 */
const ENDS_WITH_GOODBYE: ReadonlySet<OneTimeEndReason> = new Set(['user-ended', 'idle', 'network-not-allowed']);

/** What each denial ends the connection as. */
const END_REASON_FOR_DENIAL: Record<OneTimeDenialCode, OneTimeEndReason> = {
  'user-denied': 'user-denied',
  'confirmation-mismatch': 'confirmation-mismatch',
  'link-expired': 'expired',
  'burrow-error': 'burrow-error',
};

export class OneTimeRuntime {
  readonly #origin: string;
  readonly #createWebSocket: (url: string) => RemoteWebSocket;
  readonly #createSession: OneTimeRuntimeOptions['createSession'];
  readonly #directPeering: DirectPeering;
  readonly #burrowLabel: string;
  readonly #requestApproval: (request: OneTimeApprovalRequest) => void;
  readonly #dismissApproval: () => void;
  readonly #onChange: (state: OneTimeState) => void;
  readonly #onPathRefused: (refusal: PathRefusal) => void;
  readonly #now: () => number;
  readonly #setTimer: RemoteTimer;

  /**
   * The crypto token bucket, on this runtime's own clock
   * (`docs/specs/remote-security-model.md` -> Burrow bounds). Only one `init`
   * can ever reserve the link, but every one that names it buys a handshake
   * attempt until then.
   */
  readonly #initTokens: TokenBucket;

  #state: OneTimeState = { status: 'idle' };
  /** Resolves {@link open} when `opening` ends, either way. */
  #opened: ((state: OneTimeState) => void) | null = null;

  /** The rendezvous socket, while this runtime still reads it; closed at the switch and at the end. */
  readonly #rendezvous: RendezvousHold;

  /**
   * The one-use responder keypair. **Erased at the reservation**, so no second
   * handshake can ever complete against it, and never sent anywhere but its
   * public half inside the link.
   */
  #keyPair: NoiseKeyPair | null = null;
  /** The link, once the room announced itself. */
  #link: OneTimeLink | null = null;
  /** The phone holding the link, until its session is promoted or ended. */
  #reserved: ReservedPhone | null = null;
  /** The one authorized session, from the outcome to the end. */
  #established: EstablishedE2eSession | null = null;

  /**
   * Rendezvous work, one at a time and in arrival order: an `init` awaits
   * WebCrypto, and a pipelined `transport` must not overtake it. Bounded by
   * {@link #received}, since every item was a counted message.
   */
  readonly #work: RendezvousWork[] = [];
  #draining = false;
  /**
   * Every message the room delivered after announcing itself, whatever it
   * turned out to be. **The Burrow's own copy of the room's message cap**: an
   * honest room forwards at most `MAX_ONE_TIME_FORWARDED` in both directions
   * together, so one past it is a room this runtime stops reading.
   */
  #received = 0;

  #openDeadlineAt = 0;
  /** Cancels the armed deadline timer, or null when none is armed. */
  #cancelDeadline: (() => void) | null = null;
  /** The instant the armed timer is for, so a later deadline is not re-armed. */
  #deadlineAt: number | null = null;

  constructor(options: OneTimeRuntimeOptions) {
    this.#origin = options.origin;
    this.#createWebSocket = options.createWebSocket;
    this.#createSession = options.createSession;
    this.#directPeering = options.directPeering;
    this.#burrowLabel = options.burrowLabel;
    this.#requestApproval = options.requestApproval;
    this.#dismissApproval = options.dismissApproval;
    this.#onChange = options.onChange;
    this.#onPathRefused = options.onPathRefused ?? (() => {});
    this.#now = options.now ?? (() => Date.now());
    this.#setTimer = options.setTimer ?? realTimer;
    this.#rendezvous = new RendezvousHold(this.#setTimer);
    this.#initTokens = new TokenBucket({
      capacity: E2E_INIT_BURST,
      refillIntervalMs: E2E_INIT_REFILL_INTERVAL_MS,
      now: this.#now,
    });
  }

  get state(): OneTimeState {
    return this.#state;
  }

  /**
   * Mint the keypair, open the rendezvous, and wait for the room to announce
   * itself: resolves `waiting` with the link, or `ended` if it never came. Once
   * per runtime.
   */
  async open(): Promise<OneTimeState> {
    if (this.#state.status !== 'idle') throw new Error('a one-time runtime opens once');
    const opened = new Promise<OneTimeState>((resolve) => {
      this.#opened = resolve;
    });
    this.#openDeadlineAt = this.#now() + ONE_TIME_OPEN_TIMEOUT_MS;
    this.#setState({ status: 'opening' });
    this.#armDeadline();
    // Detached, so the deadline settles `opened` even while the keygen stalls.
    void this.#mint();
    return opened;
  }

  /** Mint the one-use keypair, then open the rendezvous if still opening. */
  async #mint(): Promise<void> {
    let keyPair: NoiseKeyPair;
    try {
      keyPair = await generateNoiseKeyPair();
    } catch (error) {
      console.warn('[one-time] could not mint the link key', error);
      this.#end('burrow-error');
      return;
    }
    // Ended while the keygen ran: nothing may open a socket for it now.
    if (this.#state.status !== 'opening') return;
    this.#keyPair = keyPair;
    this.#connect();
  }

  /** End the connection, whatever it is doing. Idempotent. */
  end(reason: OneTimeEndReason = 'user-ended'): void {
    this.#end(reason);
  }

  // --- The rendezvous socket -------------------------------------------------

  #connect(): void {
    const url = `${this.#origin.replace(/^http/, 'ws')}${ONE_TIME_WS_ROUTES.burrow}`;
    let ws: RemoteWebSocket;
    try {
      ws = this.#createWebSocket(url);
    } catch (error) {
      console.warn('[one-time] could not open the rendezvous', error);
      this.#end('unreachable');
      return;
    }
    const rendezvous = this.#rendezvous;
    rendezvous.hold(ws);
    ws.addEventListener('open', () => {
      if (rendezvous.reads(ws)) rendezvous.armPing(ws);
    });
    ws.addEventListener('message', (ev) => {
      if (rendezvous.reads(ws)) this.#onMessage((ev as { data?: unknown }).data);
    });
    ws.addEventListener('error', () => {
      // A `close` always follows.
    });
    ws.addEventListener('close', (ev) => {
      // Only the socket this runtime still reads: the one it closed itself at
      // the switch or the end was detached first.
      if (!rendezvous.reads(ws)) return;
      rendezvous.detach();
      this.#enqueue({ kind: 'closed', code: closeCode(ev) });
    });
  }

  /** One frame to the phone, through the room. Every Burrow->phone byte goes through here. */
  #sendFrame(step: OneTimeBurrowFrame['step'], ciphertext: Uint8Array): void {
    const frame: OneTimeBurrowFrame = { t: 'one-time', step, ct: toBase64Url(ciphertext) };
    try {
      this.#rendezvous.socket?.send(JSON.stringify(frame));
    } catch {
      // socket mid-close
    }
  }

  #onMessage(raw: unknown): void {
    // A whole string, never JSON; the room answers pings itself and never
    // forwards or counts the answer, so neither does this.
    if (raw === RELAY_PONG) return;
    if (!this.#link) {
      this.#onRoomMessage(raw);
      return;
    }
    if (++this.#received > MAX_ONE_TIME_FORWARDED) {
      console.warn('[one-time] the rendezvous forwarded more than a handshake');
      this.#end('burrow-error');
      return;
    }
    const frame = parseOneTimeFrame(raw);
    if (!isOneTimeClientFrame(frame)) return;
    this.#enqueue({ kind: 'frame', frame });
  }

  /**
   * The room's first message: exactly one `one-time-room` frame, or this
   * rendezvous is not one this runtime can use.
   *
   * **One clock for the expiry.** This runtime's own `now` plus the link TTL
   * bounds it, and the room's `expiresAt` only ever shortens it: an advertised
   * expiry that over-promised would send a phone into a room already gone.
   */
  #onRoomMessage(raw: unknown): void {
    const room = parseOneTimeFrame(raw);
    const keyPair = this.#keyPair;
    if (!isOneTimeRoomFrame(room) || !keyPair) {
      console.warn('[one-time] the rendezvous did not announce a room');
      this.#end('unreachable');
      return;
    }
    const link = linkFor(room, keyPair, this.#now());
    let url: string;
    try {
      url = formatOneTimeLinkUrl(this.#origin, link);
    } catch (error) {
      console.warn('[one-time] could not compose the link', error);
      this.#end('burrow-error');
      return;
    }
    this.#link = link;
    this.#setState({ status: 'waiting', url, expiresAt: link.expiry * 1000 });
    this.#armDeadline();
  }

  #enqueue(work: RendezvousWork): void {
    this.#work.push(work);
    if (this.#draining) return;
    this.#draining = true;
    // Deferred, like the first step of `BurrowRuntime`'s chain: a synchronous
    // `end()` clears queued work before it can start.
    void Promise.resolve().then(() => this.#drain());
  }

  async #drain(): Promise<void> {
    try {
      while (this.#work.length > 0) {
        const work = this.#work.shift()!;
        try {
          if (work.kind === 'closed') this.#onRendezvousClosed(work.code);
          else if (work.frame.step === 'init') await this.#onInit(work.frame.ct);
          else this.#onTransport(work.frame.ct);
        } catch (error) {
          // Rejections must not escape into Node or stall the next item.
          console.warn('[one-time] rendezvous work failed', error);
        }
      }
    } finally {
      this.#draining = false;
    }
  }

  /**
   * The room closed this socket. **Before the switch that ends the connection,
   * with the reason the room's code names; after it, nothing**: the direct
   * channel is the lifecycle authority from the switch on.
   */
  #onRendezvousClosed(code: number | undefined): void {
    const status = this.#state.status;
    if (status === 'ended' || status === 'connected') return;
    this.#end(this.#link ? endReasonForClose(code) : 'unreachable');
  }

  // --- The ceremony ----------------------------------------------------------

  /**
   * Noise message 1 against the link's key. **Reserve only after message 2 and
   * Split also succeed**; every later init is dropped before any WebCrypto runs.
   */
  async #onInit(ct: string): Promise<void> {
    const link = this.#link;
    const keyPair = this.#keyPair;
    if (!link || !keyPair || this.#reserved || this.#established) return;
    // The last gate before any WebCrypto runs.
    if (this.#initTokens.take() !== null) return;
    let session: NoiseTransportSession;
    let message2: Uint8Array;
    try {
      const handshake = await createNoiseResponder({
        prologue: oneTimeLinkPrologue(link),
        staticKeyPair: keyPair,
      });
      const payload = await handshake.readMessage(fromBase64Url(ct));
      // Both handshake payloads are empty; anything else is a peer this Burrow
      // does not speak the same protocol as.
      if (payload.length !== 0) throw new NoiseError('one-time message 1 carries a payload');
      message2 = await handshake.writeMessage();
      session = new NoiseTransportSession(handshake.session);
    } catch {
      // The link stays open: IK and Split did not both complete, so nobody holds it.
      return;
    }
    // Ended while the WebCrypto ran — the end erases the key.
    if (this.#keyPair !== keyPair || this.#reserved) return;
    this.#reserved = { session, request: null, attempted: false };
    this.#keyPair = null;
    this.#sendFrame('response', message2);
    this.#armDeadline();
  }

  /**
   * One transport frame: the request while the link is reserved, then the
   * session's own, which the established session reads.
   */
  #onTransport(ct: string): void {
    if (this.#established) {
      this.#established.onRelayFrame(ct);
      return;
    }
    const reserved = this.#reserved;
    if (!reserved) return;
    let receipt: TransportReceipt;
    try {
      receipt = reserved.session.receive(fromBase64Url(ct));
    } catch {
      // Nothing can be said on a poisoned session.
      this.#end('burrow-error');
      return;
    }
    if (receipt.kind === 'keepalive') return;
    // Already surfaced: further traffic is noise until the person answers.
    if (reserved.request) return;
    if (receipt.kind !== 'control' || !isOneTimeRequestV1(receipt.value)) {
      this.#deny(reserved, 'burrow-error');
      return;
    }
    const link = this.#link!;
    if (oneTimeLinkExpired(link, this.#now())) {
      this.#deny(reserved, 'link-expired');
      return;
    }
    // **The modal never shows text the phone chose**: it picks the digits too,
    // and a label drawn above their input could name them. Mapped once, here,
    // so the modal, the panel, and the indicator see the same member.
    const request = { code: receipt.value.code, label: knownOneTimeDeviceLabel(receipt.value.label) };
    reserved.request = request;
    this.#setState({ status: 'confirming', label: request.label, expiresAt: link.expiry * 1000 });
    this.#requestApproval({
      label: request.label,
      requestedAt: this.#now(),
      approve: (code) => this.#approve(reserved, code),
      deny: () => this.#denyLocally(reserved),
    });
  }

  /**
   * The local confirmation — **exactly one attempt**, spent before the expiry
   * check and the comparison, so nothing can leave a retry behind.
   */
  #approve(reserved: ReservedPhone, code: string): void {
    if (this.#reserved !== reserved || !reserved.request || reserved.attempted) return;
    reserved.attempted = true;
    if (oneTimeLinkExpired(this.#link!, this.#now())) {
      this.#deny(reserved, 'link-expired');
      return;
    }
    if (!constantTimeEqual(utf8Encode(code), utf8Encode(reserved.request.code))) {
      this.#deny(reserved, 'confirmation-mismatch');
      return;
    }
    this.#promote(reserved, reserved.request.label);
  }

  #denyLocally(reserved: ReservedPhone): void {
    if (this.#reserved !== reserved || reserved.attempted) return;
    reserved.attempted = true;
    this.#deny(reserved, 'user-denied');
  }

  /** Send one denial on the reserved session, then end; every denial runs through here. */
  #deny(reserved: ReservedPhone, code: OneTimeDenialCode): void {
    if (this.#reserved !== reserved) return;
    const outcome: OneTimeOutcomeV1 = { ok: false, code };
    const ciphertext = sealControl(reserved.session, outcome);
    if (ciphertext) this.#sendFrame('transport', ciphertext);
    this.#end(END_REASON_FOR_DENIAL[code]);
  }

  /**
   * Success: answer, then promote **the same** Noise session, direct-only:
   * from here the direct path has `DIRECT_ONLY_DEADLINE_MS` to carry both
   * directions, and no application message may arrive any other way.
   */
  #promote(reserved: ReservedPhone, label: string): void {
    const link = this.#link!;
    const outcome: OneTimeOutcomeV1 = {
      ok: true,
      burrowLabel: boundedBurrowLabel(this.#burrowLabel),
    };
    const ciphertext = sealControl(reserved.session, outcome);
    this.#reserved = null;
    if (!ciphertext) {
      this.#end('burrow-error');
      return;
    }
    const createSession = this.#createSession;
    try {
      const e2e: EstablishedE2eSession = new EstablishedE2eSession({
        session: reserved.session,
        createApi: (send) =>
          createSession({
            burrowId: link.roomId,
            send,
            label,
            end: () => {
              if (this.#established === e2e) this.#end('user-ended');
            },
          }),
        directPeering: this.#directPeering,
        sendRelay: (relayed) => this.#sendFrame('transport', relayed),
        onFatal: (reason) => this.#onSessionFatal(e2e, reason),
        directOnly: true,
        onDirectOnlyBroken: (reason) => this.#onDirectOnlyBroken(e2e, reason),
        onTransportChanged: (path) => this.#onTransportChanged(e2e, path),
        now: this.#now,
        setTimer: this.#setTimer,
      });
      this.#established = e2e;
    } catch (error) {
      // Before the outcome is sent: the phone hears only that the room closed.
      console.warn('[one-time] could not serve the session', error);
      this.#end('burrow-error');
      return;
    }
    this.#sendFrame('transport', ciphertext);
    this.#setState({ status: 'connecting', label });
    this.#armDeadline();
  }

  // --- The session -----------------------------------------------------------

  /**
   * Both directions are direct. **The switch hands the lifecycle to the
   * channel**: the rendezvous is closed normally and its loss is no longer an
   * ending.
   */
  #onTransportChanged(e2e: EstablishedE2eSession, path: DirectPath): void {
    const state = this.#state;
    if (this.#established !== e2e || state.status !== 'connecting' || path !== 'direct') return;
    this.#rendezvous.close();
    // Nothing queued is read any more: the room is not a path from here.
    this.#work.length = 0;
    this.#setState({ status: 'connected', label: state.label, since: this.#now() });
    this.#armDeadline();
  }

  /**
   * The session cannot be direct, which is the only way it runs. **Application
   * data never crosses the rendezvous**, so a phone that sends it there is not
   * one this Burrow serves; a refused path, a given-up attempt, or a missed
   * deadline has no relay to fall back to (`EstablishedE2eSession`'s
   * `directOnly`), and ends `network-not-allowed` where the path was why.
   */
  #onDirectOnlyBroken(e2e: EstablishedE2eSession, reason: DirectOnlyBreak): void {
    if (this.#established !== e2e) return;
    if (reason === 'relayed-app') {
      console.warn('[one-time] an application message arrived over the rendezvous');
      this.#end('burrow-error');
      return;
    }
    const refusal = e2e.pathRefusal;
    if (!refusal) {
      this.#end('direct-failed');
      return;
    }
    this.#onPathRefused(refusal);
    this.#end('network-not-allowed', refusal);
  }

  /** The session is over: before the switch no direct path formed, and after it the phone went. */
  #onSessionFatal(e2e: EstablishedE2eSession, reason: string): void {
    if (this.#established !== e2e) return;
    console.warn(`[one-time] the session ended: ${reason}`);
    this.#end(this.#state.status === 'connected' ? 'phone-left' : 'direct-failed');
  }

  // --- Deadlines -------------------------------------------------------------

  /**
   * Every deadline this runtime owns in its current state, as `{ at, expire }`
   * over absolute timestamps; each one ends it. **All on this runtime's own
   * clock**, and never later than the room's: a room that never closes does not
   * keep this one open.
   */
  #deadlines(): Array<{ at: number; expire: () => void }> {
    const state = this.#state;
    const link = this.#link;
    switch (state.status) {
      case 'opening':
        return [{ at: this.#openDeadlineAt, expire: () => this.#end('unreachable') }];
      case 'waiting':
      case 'confirming': {
        if (!link) return [];
        const reserved = this.#reserved;
        // A link not yet promoted ends the first millisecond it is expired;
        // a claimed one tells its phone why, which dismisses the modal. The
        // room's grace is for the direct deadline of a promotion, never this.
        const expire = reserved
          ? () => this.#deny(reserved, 'link-expired')
          : () => this.#end('expired');
        return [{ at: link.expiry * 1000 + 1, expire }];
      }
      case 'connecting': {
        const e2e = this.#established;
        const directBy = e2e?.directDeadlineAt ?? null;
        return [
          ...(e2e && directBy !== null
            ? [{ at: directBy, expire: () => e2e.expireDirectOnly() }]
            : []),
          ...this.#idleDeadline(),
        ];
      }
      case 'connected':
        return this.#idleDeadline();
      default:
        return [];
    }
  }

  /** The established session's idle deadline, which only its own decrypts move. */
  #idleDeadline(): Array<{ at: number; expire: () => void }> {
    const e2e = this.#established;
    return e2e ? [{ at: e2e.idleDeadlineAt, expire: () => this.#end('idle') }] : [];
  }

  #reap(): void {
    const now = this.#now();
    for (const deadline of this.#deadlines()) {
      if (deadline.at <= now) {
        deadline.expire();
        break;
      }
    }
    this.#armDeadline();
  }

  /**
   * Arm the timer for the soonest deadline it does not already cover. One that
   * moved *later* — a keepalive refreshing the idle clock — needs no re-arm: the
   * armed timer fires early, reaps nothing, and arms itself again.
   */
  #armDeadline(): void {
    let at = Number.POSITIVE_INFINITY;
    for (const deadline of this.#deadlines()) at = Math.min(at, deadline.at);
    if (!Number.isFinite(at)) {
      this.#clearDeadline();
      return;
    }
    if (this.#deadlineAt !== null && at >= this.#deadlineAt) return;
    this.#clearDeadline();
    this.#deadlineAt = at;
    this.#cancelDeadline = this.#setTimer(() => {
      this.#cancelDeadline = null;
      this.#deadlineAt = null;
      this.#reap();
    }, Math.max(0, at - this.#now()));
  }

  #clearDeadline(): void {
    this.#cancelDeadline?.();
    this.#cancelDeadline = null;
    this.#deadlineAt = null;
  }

  // --- State -----------------------------------------------------------------

  /**
   * The one way this runtime ends. **Everything it holds goes**: the session and
   * its peer connection, the reserved phone, the key, the queued work, every
   * timer, and the socket — closed normally, after being detached. Nothing is
   * written anywhere, and nothing resumes.
   */
  #end(reason: OneTimeEndReason, refusal?: PathRefusal): void {
    const previous = this.#state;
    if (previous.status === 'ended') return;
    // First, so nothing the teardown below re-enters can end it twice.
    this.#state = refusal ? { status: 'ended', reason, refusal } : { status: 'ended', reason };
    this.#clearDeadline();
    this.#work.length = 0;
    const e2e = this.#established;
    this.#established = null;
    // An ending this laptop chose tells the phone, before the room closes: a
    // session still connecting has its goodbye ride the rendezvous.
    if (e2e && ENDS_WITH_GOODBYE.has(reason)) e2e.end();
    this.#rendezvous.close();
    this.#reserved = null;
    this.#keyPair = null;
    e2e?.dispose();
    this.#announce(previous);
  }

  #setState(next: OneTimeState): void {
    const previous = this.#state;
    if (previous.status === 'ended') return;
    this.#state = next;
    this.#announce(previous);
  }

  /** Tell the owner, dismissing a request that is no longer awaiting a person. */
  #announce(previous: OneTimeState): void {
    const state = this.#state;
    if (previous.status === 'confirming' && state.status !== 'confirming') this.#dismissApproval();
    if (previous.status === 'opening' && state.status !== 'opening') {
      const opened = this.#opened;
      this.#opened = null;
      opened?.(state);
    }
    this.#onChange(state);
  }
}

/**
 * The link for one room: its id, the earlier of the two expiries floored to
 * the link's whole seconds, and the one-use key's public half.
 */
function linkFor(room: OneTimeRoomFrame, keyPair: NoiseKeyPair, now: number): OneTimeLink {
  const expiresAt = Math.min(now + ONE_TIME_LINK_TTL_MS, room.expiresAt);
  return {
    roomId: room.roomId,
    expiry: Math.floor(expiresAt / 1000),
    ephPub: keyPair.publicKey,
    ephPubBase64Url: toBase64Url(keyPair.publicKey),
  };
}

/** What a close from the room, before the switch, ends the connection as. */
function endReasonForClose(code: number | undefined): OneTimeEndReason {
  switch (code) {
    case WS_CLOSE_ONE_TIME_PEER_GONE:
      return 'phone-left';
    case WS_CLOSE_ONE_TIME_EXPIRED:
    case WS_CLOSE_ONE_TIME_DEADLINE:
      return 'expired';
    case WS_CLOSE_ONE_TIME_VIOLATION:
      return 'burrow-error';
    default:
      return 'rendezvous-lost';
  }
}

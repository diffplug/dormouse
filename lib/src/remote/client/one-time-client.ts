/**
 * The phone's half of a one-time connection (`docs/specs/one-time.md` ->
 * "Phone client"): one rendezvous socket, which exists only from
 * {@link OneTimeClient.connectOnce} to the direct switch, and one session on
 * {@link ClientSessionCore}, which runs over the direct path or not at all.
 *
 * **The link and two typed digits are the whole authorization, and it keeps
 * nothing** (`docs/specs/remote-security-model.md` -> "One-time connection"):
 * its Noise static is minted for the one handshake, never leaves WebCrypto, and
 * goes with the session — no pin, no passkey, no record. This module imports no
 * store, passkey, push, or worker code, and `scripts/e2e-lint.mjs` holds that
 * textually.
 *
 * **Single-use.** A client connects once and ends once; nothing resumes, and a
 * new link is a new client.
 */

import {
  DIRECT_ONLY_DEADLINE_MS,
  NoiseTransportSession,
  ONE_TIME_EXPIRY_GRACE_MS,
  RELAY_PONG,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  WS_CLOSE_ONE_TIME_DEADLINE,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_TAKEN,
  WS_CLOSE_ONE_TIME_UNAVAILABLE,
  createNoiseInitiator,
  fromBase64Url,
  generateNoiseKeyPair,
  isOneTimeBurrowFrame,
  isOneTimeOutcomeV1,
  oneTimeLinkExpired,
  oneTimeLinkPrologue,
  samplePairingCode,
  toBase64Url,
  type DirectPath,
  type DirectoryEntry,
  type E2eClientStep,
  type HelloResult,
  type OneTimeClientFrame,
  type OneTimeDenialCode,
  type OneTimeLink,
  type OneTimeRequestV1,
  type TerminalAttachResult,
} from 'remote-lib-common';

import { parseOneTimeFrame, RendezvousHold } from '../one-time-rendezvous';
import { closeCode, realTimer, type RemoteTimer, type RemoteWebSocket } from '../ws';
import type { RemoteAdapterClient, TerminalHandlers } from './remote-adapter';
import { ClientSessionCore, networkNotAllowedMessage, type ClientSessionCoreDeps } from './session-core';

/** Shown when the room refused the join: another phone holds the link, or the room is gone. */
export const ONE_TIME_LINK_USED_MESSAGE =
  'This link was already used or is no longer valid. Open a new link from your computer.';

/** Shown when the link ran out before the connection finished. */
export const ONE_TIME_LINK_EXPIRED_MESSAGE = 'This link expired. Open a new link from your computer.';

/** Shown when the connection ended, at either end, for a reason this phone cannot name. */
export const ONE_TIME_ENDED_MESSAGE =
  'The connection to your computer ended. Open a new link from your computer to connect again.';

/**
 * Shown when no direct path formed: declined, abandoned, not in time, or ended
 * by the computer's network policy. A phone is never told the policy's level,
 * so the fix it names holds under every level that opens a link.
 */
export const ONE_TIME_DIRECT_FAILED_MESSAGE =
  "Couldn't connect to your computer directly. Try your phone on another network, or check the " +
  "computer's Settings → Network, then open a new link.";

/** Shown when the rendezvous never opened: offline, refused, or rate-limited. Nothing was spent. */
export const ONE_TIME_UNREACHABLE_MESSAGE =
  "Couldn't reach Dormouse's connection service. Check this phone's internet connection, then try again.";

/**
 * What the user reads for each Burrow-sent denial.
 *
 * **Fixed copy, never Burrow- or room-supplied text**, for the reason
 * `PAIRING_DENIAL_MESSAGES` is: the outcome is authenticated, but a denial is
 * one of a closed set, so the code selects a sentence written here.
 */
export const ONE_TIME_DENIAL_MESSAGES: Record<OneTimeDenialCode, string> = {
  'user-denied': 'The connection was declined on the computer. Open a new link there to try again.',
  'confirmation-mismatch':
    'The digits typed on the computer did not match. Open a new link there to try again.',
  'link-expired': ONE_TIME_LINK_EXPIRED_MESSAGE,
  'burrow-error': 'The computer could not finish the connection. Open a new link there to try again.',
};

/** What a protocol-v1 call made before the switch rejects with; never shown by a correct page. */
const NOT_DIRECT_YET = 'the one-time connection is not direct yet';

/** Where this client's frames are addressed: the one room, for its whole life. */
interface OneTimeRoute {
  readonly kind: 'one-time';
  readonly id: string;
}

/**
 * What a `OneTimeClient` is built from. The session core's own seams — `now`,
 * `setTimer`, `visibility`, `createDirectPeer` — pass straight through to it.
 */
export interface OneTimeClientDeps
  extends Pick<ClientSessionCoreDeps<OneTimeRoute>, 'now' | 'setTimer' | 'visibility' | 'createDirectPeer'> {
  /**
   * The rendezvous origin as a socket origin — `wss://`, or `ws://` on
   * loopback — with no path; the page derives it from its own.
   */
  readonly wsOrigin: string;
  /** Open the client route; a browser `WebSocket` satisfies it. */
  readonly createWebSocket: (url: string) => RemoteWebSocket;
}

/** Where a one-time connection attempt ended, as the page reports it. */
export type OneTimeResult =
  | { readonly ok: true; readonly burrowLabel: string }
  | { readonly ok: false; readonly message: string };

/** Where this client is. Each phase is left once, in this order, and every path ends at `ended`. */
type Phase =
  /** Built; no socket yet. */
  | 'idle'
  /** The rendezvous is open: the handshake, then the person at the computer. */
  | 'confirming'
  /** Confirmed; the direct path has `DIRECT_ONLY_DEADLINE_MS` to carry both directions. */
  | 'connecting'
  /** Direct both ways and the rendezvous closed: protocol-v1 may run. */
  | 'connected'
  | 'ended';

export class OneTimeClient implements RemoteAdapterClient {
  readonly #wsOrigin: string;
  readonly #createWebSocket: (url: string) => RemoteWebSocket;
  readonly #now: () => number;
  readonly #setTimer: RemoteTimer;
  /** Everything the ceremony's frames and the established session do. */
  readonly #core: ClientSessionCore<OneTimeRoute>;

  #phase: Phase = 'idle';
  #route: OneTimeRoute | null = null;
  /** The link `connectOnce` was given, so a close can tell whether it had expired. */
  #link: OneTimeLink | null = null;
  /**
   * Cancels the timer armed at the room's hard deadline, which bounds every
   * wait before the outcome — WebCrypto and the socket's open included.
   */
  #cancelDeadline: (() => void) | null = null;

  /** The rendezvous socket, while this client still reads it; closed at the switch and at the end. */
  readonly #rendezvous: RendezvousHold;
  /** Whether the socket ever opened: a close before that means the room was never reached. */
  #opened = false;

  /**
   * The first failure's fixed copy: **set once by {@link #fail}**, so what the
   * attempt resolves with is the first thing that went wrong, whatever the
   * teardown behind it then reports. Only an authenticated outcome overrides it.
   */
  #failure: string | null = null;
  /** Rejects when {@link #failure} is set; see {@link #race}. */
  #interrupted: Promise<never> = new Promise(() => {});
  #interrupt: ((error: Error) => void) | null = null;
  /** Whether `connectOnce` resolved `ok`: from then on an ending is {@link setOnEnded}'s to report. */
  #announced = false;
  #onEnded: ((message: string) => void) | null = null;

  constructor(deps: OneTimeClientDeps) {
    this.#wsOrigin = deps.wsOrigin;
    this.#createWebSocket = deps.createWebSocket;
    this.#now = deps.now ?? (() => Date.now());
    this.#setTimer = deps.setTimer ?? realTimer;
    this.#rendezvous = new RendezvousHold(this.#setTimer);
    this.#core = new ClientSessionCore<OneTimeRoute>({
      // One route for the client's whole life, so the core's is always it.
      sendFrame: (_route, step, ciphertext) => this.#sendFrame(step, ciphertext),
      messages: {
        unavailable: ONE_TIME_LINK_EXPIRED_MESSAGE,
        reaped: ONE_TIME_ENDED_MESSAGE,
        ended: ONE_TIME_ENDED_MESSAGE,
      },
      now: this.#now,
      setTimer: deps.setTimer,
      visibility: deps.visibility,
      createDirectPeer: deps.createDirectPeer,
    });
    this.#core.setOnTransportChanged((path) => this.#onTransportChanged(path));
    this.#core.setOnBurrowGone((endedByBurrow) => this.#onSessionGone(endedByBurrow));
  }

  /**
   * Notified once, when a session `connectOnce` resolved `ok` for ends on its
   * own — the channel lost, the computer's End, the idle deadline. Never for
   * {@link close}, and never for a failed attempt, which `connectOnce` reports.
   */
  setOnEnded(callback: ((message: string) => void) | null): void {
    this.#onEnded = callback;
  }

  // --- The ceremony ----------------------------------------------------------

  /**
   * The whole one-time ceremony against one link
   * (`docs/specs/remote-security-model.md` -> "One-time connection"), and the
   * only thing that opens a socket: the page calls it on the person's tap.
   *
   * **Resolves `ok` only once the direct path carries both directions** and the
   * rendezvous is closed, so a page that mounts its wall on the result sends no
   * protocol-v1 before the switch. `onCode` fires the moment the two digits
   * exist, because the screen has to show them while the outcome is pending;
   * `onConfirmed` fires once, when an `ok` outcome is read and the direct path
   * is about to be tried. Every failure resolves with fixed copy; nothing
   * throws but a second call.
   */
  async connectOnce(
    link: OneTimeLink,
    label: string,
    onCode: (code: string) => void,
    onConfirmed?: () => void,
  ): Promise<OneTimeResult> {
    if (this.#phase !== 'idle') throw new Error('a one-time client connects once');
    this.#phase = 'confirming';
    this.#interrupted = new Promise<never>((_, reject) => {
      this.#interrupt = reject;
    });
    // Raced, never awaited alone: a failure with nothing waiting is not unhandled.
    this.#interrupted.catch(() => undefined);
    // Advisory, like the parser's check — the Burrow holds its own copy — but a
    // link that is already dead must not spend the room's one join.
    if (oneTimeLinkExpired(link, this.#now())) return this.#finish(ONE_TIME_LINK_EXPIRED_MESSAGE);
    const route: OneTimeRoute = { kind: 'one-time', id: link.roomId };
    this.#route = route;
    this.#link = link;
    // The room's hard deadline: no answer can arrive after it.
    const deadline = link.expiry * 1000 + ONE_TIME_EXPIRY_GRACE_MS;
    this.#cancelDeadline = this.#setTimer(
      () => this.#fail(ONE_TIME_LINK_EXPIRED_MESSAGE),
      Math.max(0, deadline - this.#now()),
    );
    try {
      const session = await this.#handshake(link, route, deadline);
      const code = samplePairingCode();
      // Before the request: the person reads these two digits off this screen
      // and types them on the computer while the outcome is pending.
      onCode(code);
      const request: OneTimeRequestV1 = { code, label };
      // Not raced: a failure rejects the core's waiter only while it is still
      // waiting, so an outcome that arrived before the room closed is read.
      const outcome = await this.#core.exchangeControl(route, session, { ...request }, deadline);
      // **The outcome outranks the close behind it**: a Burrow that denies then
      // leaves the room, and the denial is what the person must read.
      if (!isOneTimeOutcomeV1(outcome)) return this.#finish(ONE_TIME_DENIAL_MESSAGES['burrow-error']);
      if (!outcome.ok) return this.#finish(ONE_TIME_DENIAL_MESSAGES[outcome.code]);
      // An approval the room closed behind: no peer for a room that is gone.
      if (this.#failure !== null) throw new Error(this.#failure);
      // The digits have done their job: the screen moves on to the direct path.
      onConfirmed?.();
      // From here the direct path's own deadline bounds the wait.
      this.#clearDeadline();
      this.#phase = 'connecting';
      // After the outcome and never before: `establish` builds the direct
      // path, and a peer connection that existed ahead of authorization would
      // be one an unauthorized party had steered.
      this.#core.establish(route, session);
      // The core's wait reads an offer that gave up synchronously inside
      // `establish`, so asking after it misses nothing.
      const failure = await this.#race(this.#core.awaitDirect(DIRECT_ONLY_DEADLINE_MS));
      if (failure !== null) {
        // A computer that said it ended the connection is the end, for the
        // reason it gave; anything else before the switch is no direct path.
        this.#fail(failure === 'ended-by-burrow' ? this.#endedByBurrowMessage() : ONE_TIME_DIRECT_FAILED_MESSAGE);
        throw new Error(this.#failure ?? ONE_TIME_DIRECT_FAILED_MESSAGE);
      }
      this.#announced = true;
      return { ok: true, burrowLabel: outcome.burrowLabel };
    } catch {
      // A failure nothing recorded is the core's own deadline, or a peer this
      // phone does not speak the same protocol as.
      const unrecorded =
        this.#now() >= deadline ? ONE_TIME_LINK_EXPIRED_MESSAGE : ONE_TIME_DENIAL_MESSAGES['burrow-error'];
      return this.#finish(this.#failure ?? unrecorded);
    }
  }

  /**
   * IK against the link's one-use key, with a static minted here for this
   * handshake alone. **The socket opens only after message 1 exists**, so a
   * browser that cannot run the suite spends nothing.
   */
  async #handshake(
    link: OneTimeLink,
    route: OneTimeRoute,
    deadline: number,
  ): Promise<NoiseTransportSession> {
    // Nonextractable, and never written anywhere: the phone is left holding
    // nothing a later visit could present, which is the whole of "one-time".
    const staticKeyPair = await this.#race(generateNoiseKeyPair());
    const handshake = await this.#race(
      createNoiseInitiator({
        prologue: oneTimeLinkPrologue(link),
        staticKeyPair,
        remoteStaticPublicKey: link.ephPub,
      }),
    );
    const message1 = await this.#race(handshake.writeMessage());
    await this.#race(this.#openRendezvous(route.id));
    // The core's own wait, which a failure rejects; see `connectOnce`.
    const response = await this.#core.exchange(route, message1, deadline);
    // Both handshake payloads are empty; anything else is a peer this phone
    // does not speak the same protocol as.
    const payload = await this.#race(handshake.readMessage(fromBase64Url(response)));
    if (payload.length !== 0) throw new Error('one-time message 2 carries a payload');
    return new NoiseTransportSession(handshake.session);
  }

  /**
   * One wait in the ceremony that the core does not own — WebCrypto, the
   * socket's open, the switch — cut short by the first failure: a room that
   * closed, the room's hard deadline, a direct path given up, {@link close}.
   * **Checked again after it settles**, since a step can finish in the same
   * turn as the failure that makes its result moot.
   */
  async #race<T>(step: Promise<T>): Promise<T> {
    const value = await Promise.race([step, this.#interrupted]);
    if (this.#failure !== null) throw new Error(this.#failure);
    return value;
  }

  /** The attempt failed, for the reason `message` words: wake whatever it awaits. */
  #fail(message: string): void {
    if (this.#announced || this.#phase === 'idle' || this.#phase === 'ended') return;
    this.#failure ??= message;
    this.#interrupt?.(new Error(message));
    this.#core.rejectAll(new Error(message));
  }

  #clearDeadline(): void {
    this.#cancelDeadline?.();
    this.#cancelDeadline = null;
  }

  /** End the attempt with `message`, and release everything. */
  #finish(message: string): OneTimeResult {
    this.#failure = message;
    this.#teardown();
    return { ok: false, message };
  }

  // --- The direct path -------------------------------------------------------

  /**
   * Both directions are direct. **The switch hands the lifecycle to the
   * channel**: the rendezvous is closed normally and its loss is no longer an
   * ending. A given-up attempt is `connectOnce`'s, through the core's wait.
   */
  #onTransportChanged(path: DirectPath): void {
    if (this.#phase !== 'connecting' || path !== 'direct') return;
    this.#phase = 'connected';
    this.#rendezvous.close();
  }

  /**
   * The session is over at the core — a dead channel, a failed decrypt, a
   * session the Burrow let go. Before the switch that is no direct path, unless
   * the laptop said it ended the connection; after it, the end.
   */
  #onSessionGone(endedByBurrow: boolean): void {
    if (this.#phase === 'connecting') {
      this.#fail(endedByBurrow ? this.#endedByBurrowMessage() : ONE_TIME_DIRECT_FAILED_MESSAGE);
      return;
    }
    if (this.#phase !== 'connected') return;
    if (!this.#announced) {
      // Lost between the switch and `connectOnce`'s own return.
      this.#fail(ONE_TIME_ENDED_MESSAGE);
      return;
    }
    this.#teardown();
    this.#onEnded?.(ONE_TIME_ENDED_MESSAGE);
  }

  /**
   * What the laptop's goodbye before the switch reads as: why the path ended
   * it, where it named this phone's address; the generic direct failure where
   * the path was why and it named none; else an ending.
   */
  #endedByBurrowMessage(): string {
    const goodbye = this.#core.goodbye;
    const named = networkNotAllowedMessage(goodbye);
    if (named !== null) return named;
    return goodbye && 'reason' in goodbye ? ONE_TIME_DIRECT_FAILED_MESSAGE : ONE_TIME_ENDED_MESSAGE;
  }

  // --- The rendezvous socket -------------------------------------------------

  /** Join the room on the client route; resolves once the socket is open. */
  #openRendezvous(roomId: string): Promise<void> {
    const room = encodeURIComponent(roomId);
    const url = `${this.#wsOrigin}${ONE_TIME_WS_ROUTES.client}?${ONE_TIME_ROOM_PARAM}=${room}`;
    let ws: RemoteWebSocket;
    try {
      ws = this.#createWebSocket(url);
    } catch (error) {
      this.#fail(ONE_TIME_UNREACHABLE_MESSAGE);
      throw error;
    }
    const rendezvous = this.#rendezvous;
    rendezvous.hold(ws);
    return new Promise<void>((resolve) => {
      ws.addEventListener('open', () => {
        if (!rendezvous.reads(ws)) return;
        this.#opened = true;
        rendezvous.armPing(ws);
        resolve();
      });
      ws.addEventListener('message', (ev) => {
        if (rendezvous.reads(ws)) this.#onMessage((ev as { data?: unknown }).data);
      });
      ws.addEventListener('error', () => {
        // After the open a `close` always follows; before it, a refused upgrade
        // may be all a browser reports.
        if (!rendezvous.reads(ws) || this.#opened) return;
        rendezvous.detach();
        this.#fail(ONE_TIME_UNREACHABLE_MESSAGE);
      });
      ws.addEventListener('close', (ev) => {
        // Only the socket this client still reads: one it closed itself, at the
        // switch or the end, was detached first.
        if (!rendezvous.reads(ws)) return;
        rendezvous.detach();
        this.#fail(this.#opened ? this.#closeMessage(closeCode(ev)) : ONE_TIME_UNREACHABLE_MESSAGE);
      });
    });
  }

  /**
   * One frame to the Burrow, through the room. **Every phone→Burrow byte before
   * the switch goes through here** — the session core's too, as its
   * `sendFrame`; throws where there is no socket to send on.
   */
  #sendFrame(step: E2eClientStep, ciphertext: Uint8Array): void {
    const ws = this.#rendezvous.socket;
    if (!ws) throw new Error('the rendezvous socket is not open');
    const frame: OneTimeClientFrame = { t: 'one-time', step, ct: toBase64Url(ciphertext) };
    ws.send(JSON.stringify(frame));
  }

  /** {@link closeMessage}, for this client's phase and link, now. */
  #closeMessage(code: number | undefined): string {
    const link = this.#link;
    return closeMessage(code, this.#phase, link !== null && oneTimeLinkExpired(link, this.#now()));
  }

  #onMessage(raw: unknown): void {
    // A whole string, never JSON: the room answers a ping itself and never
    // forwards the answer.
    if (raw === RELAY_PONG) return;
    const frame = parseOneTimeFrame(raw);
    // The shared guard bounds every value before any is used as a key or
    // decoded; this phone runs it rather than trusting the room to have.
    if (!isOneTimeBurrowFrame(frame) || !this.#route) return;
    this.#core.onFrame(this.#route, frame.step, frame.ct);
  }

  // --- Remote-api v1 (see ClientSessionCore) --------------------------------

  hello(): Promise<HelloResult> {
    return this.#whenDirect(() => this.#core.hello());
  }

  watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string> {
    return this.#whenDirect(() => this.#core.watchDirectory(onSnapshot));
  }

  attach(
    surfaceId: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): Promise<{ subId: string; result: TerminalAttachResult }> {
    return this.#whenDirect(() => this.#core.attach(surfaceId, cols, rows, handlers));
  }

  write(surfaceId: string, bytes: string): Promise<unknown> {
    return this.#whenDirect(() => this.#core.write(surfaceId, bytes));
  }

  resize(surfaceId: string, cols: number, rows: number): Promise<unknown> {
    return this.#whenDirect(() => this.#core.resize(surfaceId, cols, rows));
  }

  detach(surfaceId: string, subId?: string): Promise<unknown> {
    return this.#whenDirect(() => this.#core.detach(surfaceId, subId));
  }

  unsubscribe(subId: string): void {
    this.#core.unsubscribe(subId);
  }

  /**
   * **No protocol-v1 before the switch.** The Burrow ends a session whose
   * application message arrives over the rendezvous, and this is what keeps an
   * early call from being one: refused, never queued.
   */
  #whenDirect<T>(call: () => Promise<T>): Promise<T> {
    if (this.#phase !== 'connected') return Promise.reject(new Error(NOT_DIRECT_YET));
    return call();
  }

  // --- Endings ---------------------------------------------------------------

  /**
   * End everything, whatever it is doing: a pending `connectOnce` resolves with
   * {@link ONE_TIME_ENDED_MESSAGE}, and {@link setOnEnded} hears nothing.
   * Idempotent.
   */
  close(): void {
    this.#fail(ONE_TIME_ENDED_MESSAGE);
    this.#teardown();
  }

  /**
   * Release everything: the session and its peer connection, both timers, and
   * the socket — detached, then closed normally. Nothing is written anywhere,
   * and nothing resumes.
   */
  #teardown(): void {
    if (this.#phase === 'ended') return;
    this.#phase = 'ended';
    this.#clearDeadline();
    this.#rendezvous.close();
    this.#core.endSession(this.#failure ?? ONE_TIME_ENDED_MESSAGE, { notifyGone: false });
  }
}

/**
 * What a room close before the switch reads as. The room is the only party
 * that knows which of its closes happened, so its code picks the copy.
 */
function closeMessage(code: number | undefined, phase: Phase, linkExpired: boolean): string {
  switch (code) {
    case WS_CLOSE_ONE_TIME_TAKEN:
    case WS_CLOSE_ONE_TIME_UNAVAILABLE:
      return ONE_TIME_LINK_USED_MESSAGE;
    case WS_CLOSE_ONE_TIME_EXPIRED:
    case WS_CLOSE_ONE_TIME_DEADLINE:
      return ONE_TIME_LINK_EXPIRED_MESSAGE;
    default:
      // Confirmed and waiting on the direct path, a room the computer left is
      // how its own direct failure reaches this phone: its answering side gives
      // up before this one's deadline, then ends the connection.
      if (phase === 'connecting') return ONE_TIME_DIRECT_FAILED_MESSAGE;
      // Before the outcome and past the expiry, the computer left because the
      // link ran out.
      return linkExpired ? ONE_TIME_LINK_EXPIRED_MESSAGE : ONE_TIME_ENDED_MESSAGE;
  }
}

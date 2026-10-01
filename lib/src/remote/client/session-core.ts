/**
 * The half of a phone-side Client that does not care how its ceremony was
 * authorized: the ceremony's frame waiters, and — once its owner establishes a
 * session — protocol-v1 as application messages on that Noise session
 * (`docs/specs/remote-api.md` owns their correlation), the offerer's direct
 * path, and the keepalives the Burrow's idle deadline reads.
 *
 * **Authorization is the owner's, and this module knows nothing of it** — no
 * passkey, no pinned record, no stored key, no HTTP. The owner runs the
 * handshake and reads the outcome, puts every frame this core addresses on its
 * own socket ({@link ClientSessionCoreDeps.sendFrame}), hands every frame its
 * guard passed back through {@link ClientSessionCore.onFrame}, and calls
 * {@link ClientSessionCore.establish} only for an authorized session.
 */

import {
  E2E_KEEPALIVE_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  fromBase64Url,
  isSessionEndV1,
  utf8Decode,
  utf8Encode,
  type DirectPath,
  type DirectRelayCause,
  type DirectSignalV1,
  type DirectoryEntry,
  type DirectorySnapshot,
  type E2eBurrowStep,
  type E2eClientStep,
  type HelloResult,
  type NoiseTransportSession,
  type RemoteEventMsg,
  type RemoteResponse,
  type SessionEndV1,
  type TerminalAttachResult,
  type TerminalClosedEvent,
  type TerminalDataEvent,
  type TransportReceipt,
} from 'remote-lib-common';
import { DirectEndpoint } from '../direct/direct-endpoint';
import type { DirectPeerFactory } from '../direct/direct-peer';
import { realTimer, type RelayHeartbeat, type RemoteTimer } from '../ws';
import type { RemoteAdapterClient, TerminalHandlers } from './remote-adapter';

/**
 * Where one ceremony's frames are addressed. The owner's envelope may carry
 * more (Pocket's names the Burrow too); a waiter is keyed on these two alone.
 */
export interface CeremonyRoute {
  readonly kind: string;
  readonly id: string;
}

/**
 * Why {@link ClientSessionCore.awaitDirect} answered without a direct path:
 * the attempt's own {@link DirectRelayCause}; `timeout`; the session lost
 * (`lost`) or ended by the Burrow's goodbye (`ended-by-burrow`); or `retired`
 * by its owner — a replacing Connect, a teardown — which reports nothing.
 */
export type DirectWaitFailure = DirectRelayCause | 'timeout' | 'lost' | 'ended-by-burrow' | 'retired';

/**
 * What a phone reads when the computer's goodbye says the path ended a
 * direct-only session (`docs/specs/remote-network.md` -> "Local networks") and
 * names this phone's address, or `null` — a goodbye that says nothing of why,
 * or names no address, which leaves the Client's generic direct-failure copy.
 * One sentence for Pocket and the one-time page, never naming the computer's
 * allowed networks, which the phone is not told; an address the phone
 * `reported` is not asserted to be off them.
 */
export function networkNotAllowedMessage(goodbye: SessionEndV1 | null): string | null {
  if (!goodbye || !('address' in goodbye)) return null;
  if (goodbye.addressSource === 'reported') {
    return (
      `This phone couldn’t reach the computer directly over one of its allowed networks (it reported ${goodbye.address}). ` +
      'If it’s on another network, join the same Wi-Fi or VPN as the computer and try again.'
    );
  }
  return (
    `This computer only accepts phones on its allowed networks. Yours connected from ${goodbye.address} — ` +
    'join the same Wi-Fi or VPN as the computer and try again.'
  );
}

/**
 * Whether this page is in front of the user, and a way to be told when that
 * changes. Injectable because keepalives are the one thing a Client does on a
 * timer, and a test must not wait thirty real seconds to see one.
 */
export interface PageVisibility {
  isVisible(): boolean;
  /** Subscribe to visibility changes; returns an unsubscribe. */
  subscribe(onChange: () => void): () => void;
}

/**
 * The fixed copy this core's own failures carry. The owner's, because each
 * Client words its own way back — reconnecting is not the same step on every
 * page.
 */
export interface ClientSessionMessages {
  /** What a ceremony frame that never arrived by its deadline rejects with. */
  readonly unavailable: string;
  /**
   * What a session the Burrow has already reaped ends with — and so what every
   * request in flight on it, and one made after, fails with.
   */
  readonly reaped: string;
  /** What a session the Burrow ended on purpose — its goodbye — ends with. */
  readonly ended: string;
}

export interface ClientSessionCoreDeps<R extends CeremonyRoute> {
  /**
   * Put one ciphertext on the owner's socket, addressed to `route`, in
   * whatever envelope that socket carries. **Every Client→Burrow byte this core
   * sends goes through here**; throws where there is no socket to send on.
   */
  sendFrame(route: R, step: E2eClientStep, ciphertext: Uint8Array): void;
  readonly messages: ClientSessionMessages;
  readonly now?: () => number;
  /** The keepalive timer, and every deadline the direct path arms; see {@link RemoteTimer}. */
  readonly setTimer?: RemoteTimer;
  readonly visibility?: PageVisibility;
  /**
   * How this runtime builds a peer connection for the direct path
   * (`docs/specs/remote-api.md` → Transport → "Direct path"), or `null` where it
   * has none. Absent, this Client never offers one and every session stays
   * relayed.
   */
  readonly createDirectPeer?: DirectPeerFactory | null;
}

interface CiphertextWaiter {
  resolve(ct: string): void;
  reject(error: Error): void;
}

interface PendingRequest {
  resolve(result: unknown): void;
  reject(error: Error): void;
}

/** An authorized session: where its frames go, and its two cipher states. */
interface EstablishedSession<R extends CeremonyRoute> {
  readonly session: NoiseTransportSession;
  /** Where this session's frames are addressed on the owner's socket; fixed for its life. */
  readonly route: R;
  /**
   * This session's direct path, created with it and disposed with it. **Every
   * byte this Client sends goes through it**, relayed or not, so there is no
   * moment at which a live session has no endpoint to route through.
   */
  readonly direct: DirectEndpoint;
  /**
   * When this Client last put a byte on this session — the mirror of the clock
   * the Burrow's `EstablishedE2eSession.idleDeadlineAt` runs from, because that
   * is the one it reaps on (`docs/specs/remote-security-model.md` → Burrow
   * bounds).
   */
  lastSentAt: number;
}

export class ClientSessionCore<R extends CeremonyRoute> implements RemoteAdapterClient {
  readonly #sendFrame: (route: R, step: E2eClientStep, ciphertext: Uint8Array) => void;
  readonly #messages: ClientSessionMessages;
  readonly #now: () => number;
  readonly #setTimer: RemoteTimer;
  readonly #visibility: PageVisibility;
  readonly #createDirectPeer: DirectPeerFactory | null;

  #established: EstablishedSession<R> | null = null;
  #onBurrowGone: ((endedByBurrow: boolean) => void) | null = null;
  #onTransportChanged:
    | ((path: DirectPath, cause: DirectRelayCause | null) => void)
    | null = null;
  /** Cancels the armed keepalive. */
  #cancelKeepalive: (() => void) | null = null;
  /** The owner's relay-socket heartbeat, run beside the keepalives; see {@link setSocketHeartbeat}. */
  #heartbeat: RelayHeartbeat | null = null;
  /** Cancels the one visibility subscription, held while a session or a heartbeat runs. */
  #cancelVisibility: (() => void) | null = null;
  /** The one {@link awaitDirect} in flight, answered by the switch or by its end. */
  #directWaiter: ((failure: DirectWaitFailure | null) => void) | null = null;
  /** The goodbye that ended the last session, until the next is established; see {@link goodbye}. */
  #goodbye: SessionEndV1 | null = null;

  /**
   * In-flight ceremony waiters, keyed by `${kind}:${id}:${step}`.
   *
   * A ceremony awaits exactly one frame at a time and every id is fresh, so at
   * most one waiter per key is ever pending — {@link #expect} throws if a
   * second is registered rather than silently queueing it.
   */
  readonly #waiters = new Map<string, CiphertextWaiter>();
  /** In-flight remote-api requests, keyed by `requestId`. */
  readonly #pending = new Map<string, PendingRequest>();
  /** Live event subscriptions, keyed by `subId`. */
  readonly #events = new Map<string, (event: RemoteEventMsg) => void>();

  constructor(deps: ClientSessionCoreDeps<R>) {
    this.#sendFrame = deps.sendFrame;
    this.#messages = deps.messages;
    this.#now = deps.now ?? (() => Date.now());
    this.#setTimer = deps.setTimer ?? realTimer;
    this.#visibility = deps.visibility ?? documentVisibility();
    this.#createDirectPeer = deps.createDirectPeer ?? null;
  }

  /**
   * The Burrow's goodbye that ended the last session — which says why, where
   * the path ended a direct-only one ({@link networkNotAllowedMessage}) — or
   * `null`: none arrived, or a session has been established since.
   */
  get goodbye(): SessionEndV1 | null {
    return this.#goodbye;
  }

  /** The established session's route, or null while there is none. */
  get establishedRoute(): R | null {
    return this.#established?.route ?? null;
  }

  /**
   * Which path carries this session, for the indicator the connected chrome
   * shows (`docs/specs/pocket-app.md`). `direct` only once **both** directions
   * have left the relay — before that the relay is still carrying half of it.
   */
  get transportPath(): DirectPath {
    return this.#established?.direct.path ?? 'relay';
  }

  /**
   * Notified whenever {@link transportPath} or the reason a session is still
   * relayed changes — the indicator's one seam, since a cause is only ever read
   * as it changes.
   */
  setOnTransportChanged(
    callback: ((path: DirectPath, cause: DirectRelayCause | null) => void) | null,
  ): void {
    this.#onTransportChanged = callback;
  }

  /**
   * Notified when the Burrow drops: every {@link loseBurrow} — a failed
   * decrypt, a dead channel, a session the Burrow's idle reaper took while this
   * page was hidden, the Burrow's goodbye — and every {@link endSession} the
   * owner asks to report. `endedByBurrow` is true for the goodbye alone: the
   * Burrow said it ended the session, which no other loss can tell apart.
   */
  setOnBurrowGone(callback: ((endedByBurrow: boolean) => void) | null): void {
    this.#onBurrowGone = callback;
  }

  // --- Ceremony frames -------------------------------------------------------

  /** Send message 1 and await the Burrow's message 2 for the same ceremony. */
  async exchange(route: R, message1: Uint8Array, deadline: number): Promise<string> {
    const key = waiterKey(route.kind, route.id, 'response');
    const awaited = this.#expect(key, deadline);
    try {
      this.#sendFrame(route, 'init', message1);
    } catch (error) {
      this.#reclaim(key, awaited, error);
      throw error;
    }
    return await awaited;
  }

  /**
   * A ceremony's one control message, and the Burrow's single answer to it.
   * Every ceremony is this shape, so the send and the await share a `try`.
   *
   * **The waiter is registered before the send**, as {@link exchange} does it:
   * an answer that arrives with no await in between — an owner's socket that
   * delivers synchronously — would otherwise reach {@link onFrame} with nobody
   * waiting, be dropped as an answer nobody asked for, and hang the ceremony to
   * its deadline. Keepalives are accepted and skipped; the first control message
   * is the outcome, whatever it says, and anything else is a peer this Client
   * does not speak the same protocol as.
   */
  async exchangeControl(
    route: R,
    session: NoiseTransportSession,
    request: Record<string, unknown>,
    deadline: number,
  ): Promise<unknown> {
    const key = waiterKey(route.kind, route.id, 'transport');
    let awaited = this.#expect(key, deadline);
    try {
      this.#sendFrame(route, 'transport', session.sendControl(request));
    } catch (error) {
      this.#reclaim(key, awaited, error);
      throw error;
    }
    for (;;) {
      const receipt = session.receive(fromBase64Url(await awaited));
      if (receipt.kind === 'control') return receipt.value;
      if (receipt.kind !== 'keepalive') throw new Error('expected a control message');
      awaited = this.#expect(key, deadline);
    }
  }

  /**
   * One frame from the Burrow, after the owner's guard has bounded every
   * routing value in it — the core never re-checks an envelope.
   */
  onFrame(route: CeremonyRoute, step: E2eBurrowStep, ct: string): void {
    const established = this.#established;
    if (
      established &&
      route.kind === established.route.kind &&
      route.id === established.route.id &&
      step === 'transport'
    ) {
      // Every rule about a frame on an authorized session — which path may
      // carry it, and that its `ct` must decode — is the endpoint's, and it is
      // created and dropped with `#established` (`docs/specs/remote-api.md` →
      // Transport → "Direct path").
      established.direct.onRelayFrame(ct);
      return;
    }
    const key = waiterKey(route.kind, route.id, step);
    const waiter = this.#waiters.get(key);
    if (!waiter) return; // an answer nobody is awaiting
    this.#waiters.delete(key);
    waiter.resolve(ct);
  }

  /**
   * Promote an authorized ceremony's session: its direct path, its keepalives,
   * and the offer. **The owner calls this only once an authenticated outcome
   * says `ok`.**
   */
  establish(route: R, session: NoiseTransportSession): void {
    // Still load-bearing for a *concurrent* ceremony to another Burrow, which
    // the owner's own retire before its request cannot see: without it that
    // session's endpoint and peer would be overwritten below rather than closed.
    this.disposeSession();
    this.#goodbye = null;
    // Declared first so the endpoint's deps can name the session they serve;
    // assigned before anything can reach them.
    let established: EstablishedSession<R>;
    // After the outcome and never before, and nowhere else: a peer connection
    // that existed ahead of authorization would be one an unauthorized party
    // had steered.
    const direct = this.#directEndpoint(() => established, route);
    established = { session, route, direct, lastSentAt: this.#now() };
    this.#established = established;
    this.#startKeepalives();
    void direct.offer();
  }

  // --- Remote-api v1 -------------------------------------------------------

  hello(): Promise<HelloResult> {
    return this.request<HelloResult>(REMOTE_METHODS.hello, { protocolVersion: 1, viewer: 'phone' });
  }

  /** Subscribe to the directory; returns the `subId` (call {@link unsubscribe} to stop). */
  async watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string> {
    const { subId } = await this.subscribe(REMOTE_METHODS.directoryWatch, {}, (event) => {
      if (event.event === REMOTE_EVENTS.directorySnapshot) {
        onSnapshot((event.data as DirectorySnapshot).entries);
      }
    });
    return subId;
  }

  /** Attach to a terminal surface with the client's size; streams via {@link TerminalHandlers}. */
  attach(
    surfaceId: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): Promise<{ subId: string; result: TerminalAttachResult }> {
    return this.subscribe<TerminalAttachResult>(
      REMOTE_METHODS.surfaceAttach,
      { surfaceId, cols, rows },
      (event) => {
        switch (event.event) {
          case REMOTE_EVENTS.terminalData:
            handlers.onData(event.data as TerminalDataEvent);
            return;
          case REMOTE_EVENTS.terminalClosed:
            handlers.onClosed?.((event.data as TerminalClosedEvent).exitCode);
            return;
          default:
            return;
        }
      },
    );
  }

  write(surfaceId: string, bytes: string): Promise<unknown> {
    return this.request(REMOTE_METHODS.terminalWrite, { surfaceId, bytes });
  }

  resize(surfaceId: string, cols: number, rows: number): Promise<unknown> {
    return this.request(REMOTE_METHODS.terminalResize, { surfaceId, cols, rows });
  }

  detach(surfaceId: string, subId?: string): Promise<unknown> {
    if (subId) this.unsubscribe(subId);
    return this.request(REMOTE_METHODS.surfaceDetach, { surfaceId });
  }

  /** Correlated request on the established session; resolves with `result`. */
  request<T = unknown>(method: string, params?: unknown, requestId: string = uuid()): Promise<T> {
    const promise = new Promise<T>((resolve, reject) => {
      this.#pending.set(requestId, { resolve: resolve as (r: unknown) => void, reject });
    });
    try {
      this.#sendApp({ requestId, method, params });
    } catch (error) {
      this.#pending.get(requestId)?.reject(error instanceof Error ? error : new Error(String(error)));
      this.#pending.delete(requestId);
    }
    return promise;
  }

  /** Request that also opens an event subscription (Burrow reuses `requestId` as `subId`). */
  async subscribe<T = unknown>(
    method: string,
    params: unknown,
    onEvent: (event: RemoteEventMsg) => void,
  ): Promise<{ subId: string; result: T }> {
    const subId = uuid();
    this.#events.set(subId, onEvent);
    try {
      const result = await this.request<T>(method, params, subId);
      return { subId, result };
    } catch (error) {
      this.#events.delete(subId);
      throw error;
    }
  }

  unsubscribe(subId: string): void {
    this.#events.delete(subId);
  }

  // --- The direct path -----------------------------------------------------

  /**
   * This session's direct path, as the offerer runs it
   * (`docs/specs/remote-api.md` → Transport → "Direct path"). Every rule about
   * the attempt, the channel, and the cutover is
   * {@link DirectEndpoint}'s; what is injected here is how this Client puts a
   * signal on the relay, decrypts a channel frame, and reports the session gone.
   */
  #directEndpoint(current: () => EstablishedSession<R>, route: R): DirectEndpoint {
    return new DirectEndpoint('offerer', {
      // A Client holds no path policy: the Burrow checks the path.
      peering: { createPeer: this.#createDirectPeer },
      sendSignal: (signal) => this.#sendDirectSignal(current(), signal),
      sendRelay: (ciphertext) => this.#sendFrame(route, 'transport', ciphertext),
      receive: (ciphertext) => this.#receiveOnSession(current(), ciphertext),
      // Reported exactly as a `burrow-gone` frame is: from here they are the
      // same event, and the app must leave the wall either way.
      fatal: (reason) => this.loseBurrow(reason),
      isCurrent: () => this.#established === current(),
      onTransportChanged: (path, cause) => {
        if (path === 'direct') this.#settleDirect(null);
        else if (cause !== null) this.#settleDirect(cause);
        this.#onTransportChanged?.(path, cause);
      },
      setTimer: this.#setTimer,
    });
  }

  /**
   * Wait for the established session's direct path to carry both directions
   * within `timeoutMs`: `null` once it does, else why not
   * ({@link DirectWaitFailure}) — at once with no session, or with an attempt
   * already given up. For a session that runs direct or not at all — a
   * one-time connection, or one whose outcome says `directOnly` — whose owner
   * sends no protocol-v1 until this answers `null`. A session that ends
   * meanwhile answers it with how it ended; burrow loss is still reported
   * ({@link setOnBurrowGone}), and an owner with no wall up yet ignores it.
   */
  awaitDirect(timeoutMs: number): Promise<DirectWaitFailure | null> {
    const established = this.#established;
    if (!established) return Promise.resolve('lost');
    if (established.direct.path === 'direct') return Promise.resolve(null);
    const cause = established.direct.relayCause;
    if (cause !== null) return Promise.resolve(cause);
    this.#settleDirect('retired');
    return new Promise((resolve) => {
      const cancel = this.#setTimer(() => this.#settleDirect('timeout'), timeoutMs);
      this.#directWaiter = (failure) => {
        cancel();
        resolve(failure);
      };
    });
  }

  #settleDirect(failure: DirectWaitFailure | null): void {
    const waiter = this.#directWaiter;
    this.#directWaiter = null;
    waiter?.(failure);
  }

  /**
   * One signal on the relay — the path that carries them until the switch. A
   * poisoned session has nothing to say; whatever poisoned it ends it.
   */
  #sendDirectSignal(established: EstablishedSession<R>, signal: DirectSignalV1): boolean {
    try {
      this.#sendFrame(established.route, 'transport', established.session.sendControl({ ...signal }));
      return true;
    } catch {
      return false;
    }
  }

  /**
   * The end-to-end session is over while the owner's socket is not: dispose it,
   * fail everything in flight, and tell the app — the same three steps a
   * `burrow-gone` frame takes, because from here they are the same event.
   *
   * **The owner's socket is left alone**, which is the whole difference from
   * the owner's own teardown: this core never touches that socket, and what the
   * owner does next — Pocket reconnects with a fresh handshake over the relay
   * socket already open — is the owner's.
   */
  loseBurrow(reason: string, { endedByBurrow = false }: { endedByBurrow?: boolean } = {}): void {
    this.endSession(reason, { notifyGone: true, endedByBurrow });
  }

  // --- Keepalives ----------------------------------------------------------

  /**
   * One fixed-size keepalive on the established session, or nothing if there
   * is none. **The only thing that refreshes the Burrow's idle deadline** other
   * than real traffic (`docs/specs/remote-security-model.md` → Burrow bounds).
   */
  sendKeepalive(): void {
    const established = this.#established;
    if (!established) return;
    if (this.#reapedByBurrow(established)) return;
    try {
      // Path-agnostic: a keepalive off the channel refreshes the Burrow's idle
      // deadline exactly as one off the relay does.
      established.direct.send(established.session.sendKeepalive());
      established.lastSentAt = this.#now();
    } catch {
      // A closed socket or a poisoned session; both have their own teardown,
      // and a keepalive must not be what reports burrow loss.
    }
  }

  /**
   * **A session the Burrow has already reaped, ended here too.**
   *
   * The Burrow disposes an established session it has not decrypted a Client
   * message on for `ESTABLISHED_E2E_IDLE_TIMEOUT_MS`, and its goodbye goes out
   * while this page is suspended — delivered late, or not at all, and nothing
   * the owner's socket carries says so. Keepalives pause while the page is
   * hidden, so a phone in a pocket crosses that line on its own, and without
   * this check it comes back to a wall whose every request hangs forever with
   * no error and no way out but a reload
   * ([pocket-app.md](../../../../docs/specs/pocket-app.md)).
   *
   * The Burrow's deadline runs from the message it last decrypted, which is the
   * one this Client last sent, so the same constant answers the question on
   * both sides. Reports burrow loss and leaves the owner's socket alone: what
   * died is the end-to-end session, and what follows is the owner's.
   */
  #reapedByBurrow(established: EstablishedSession<R>): boolean {
    if (this.#now() - established.lastSentAt < ESTABLISHED_E2E_IDLE_TIMEOUT_MS) return false;
    this.loseBurrow(this.#messages.reaped);
    return true;
  }

  /**
   * Keepalives run **only while the page is visible**, and returning to the
   * foreground sends one immediately — a tab hidden for less than the idle
   * timeout still has a session worth keeping
   * ([pocket-app.md](../../../../docs/specs/pocket-app.md)).
   */
  #startKeepalives(): void {
    this.#watchVisibility();
    this.#armKeepalive();
  }

  /**
   * Run the owner's relay-socket heartbeat — or, with `null`, none — on this
   * core's visibility, as keepalives run: stopped while the page is hidden,
   * whose throttled timers could not judge a pong, and resumed with the
   * outstanding ping forgiven when it returns. The owner starts and stops the
   * heartbeat itself.
   */
  setSocketHeartbeat(heartbeat: RelayHeartbeat | null): void {
    this.#heartbeat = heartbeat;
    if (heartbeat && !this.#visibility.isVisible()) heartbeat.stop();
    this.#watchVisibility();
  }

  /** The one visibility subscription: held while a session or a heartbeat runs, and only then. */
  #watchVisibility(): void {
    const wanted = this.#established !== null || this.#heartbeat !== null;
    if (wanted && !this.#cancelVisibility) {
      this.#cancelVisibility = this.#visibility.subscribe(() => this.#onVisibilityChange());
    } else if (!wanted && this.#cancelVisibility) {
      this.#cancelVisibility();
      this.#cancelVisibility = null;
    }
  }

  #onVisibilityChange(): void {
    const visible = this.#visibility.isVisible();
    if (visible) this.#heartbeat?.resume();
    else this.#heartbeat?.stop();
    if (this.#established && visible) this.sendKeepalive();
    // Re-arms while visible and cancels while hidden; one place decides.
    this.#armKeepalive();
  }

  #armKeepalive(): void {
    this.#cancelKeepaliveTimer();
    if (!this.#established || !this.#visibility.isVisible()) return;
    this.#cancelKeepalive = this.#setTimer(() => {
      this.#cancelKeepalive = null;
      this.sendKeepalive();
      this.#armKeepalive();
    }, E2E_KEEPALIVE_INTERVAL_MS);
  }

  #cancelKeepaliveTimer(): void {
    this.#cancelKeepalive?.();
    this.#cancelKeepalive = null;
  }


  /**
   * One protocol-v1 message on the established session, chunked as it needs.
   * **The endpoint routes every chunk**, relay or channel, so which path carries
   * them is {@link DirectEndpoint.send}'s rule rather than this loop's.
   */
  #sendApp(payload: unknown): void {
    const established = this.#established;
    if (!established) throw new Error('not connected to a burrow');
    if (this.#reapedByBurrow(established)) throw new Error(this.#messages.reaped);
    for (const ciphertext of established.session.sendApp(utf8Encode(JSON.stringify(payload)))) {
      // A channel that refuses a chunk is burrow loss, taken synchronously: the
      // rest of this message has no session left to belong to, and must reach
      // neither path.
      if (established.direct.disposed) return;
      established.direct.send(ciphertext);
    }
    established.lastSentAt = this.#now();
  }

  /**
   * Await one ciphertext for `key`, bounded by the ceremony's own deadline.
   *
   * A Burrow that never answers must not strand the key — and throw on the next
   * ask — until the socket dies. The expiry reports
   * {@link ClientSessionMessages.unavailable}, never a denial.
   */
  #expect(key: string, deadline: number): Promise<string> {
    if (this.#waiters.has(key)) throw new Error(`already awaiting '${key}'`);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => {
          this.#waiters.delete(key);
          reject(new BurrowUnavailableError(this.#messages.unavailable));
        },
        Math.max(0, deadline - this.#now()),
      );
      this.#waiters.set(key, {
        resolve: (ct) => {
          clearTimeout(timer);
          resolve(ct);
        },
        reject: (error) => {
          clearTimeout(timer);
          reject(error);
        },
      });
    });
  }

  /** Reclaim a waiter whose frame never left, so its deadline cannot fire unheard. */
  #reclaim(key: string, awaited: Promise<string>, error: unknown): void {
    this.#waiters.get(key)?.reject(error instanceof Error ? error : new Error(String(error)));
    this.#waiters.delete(key);
    void awaited.catch(() => undefined);
  }

  /**
   * Decrypt one transport ciphertext, whichever path carried it, and answer the
   * receipt for the endpoint to read a signal out of. **Any decrypt or framing
   * failure ends the session**: there is no resynchronization point in a stream
   * cipher, so a poisoned session is burrow loss and the app must leave the
   * wall.
   */
  #receiveOnSession(
    established: EstablishedSession<R>,
    ciphertext: Uint8Array,
  ): TransportReceipt | null {
    let receipt: TransportReceipt;
    try {
      receipt = established.session.receive(ciphertext);
    } catch {
      // The end-to-end session is what died, never the owner's socket, which
      // this core does not touch; what follows is the owner's.
      this.loseBurrow('the end-to-end session failed');
      return null;
    }
    // The Burrow's goodbye: it ended this session on purpose, so nothing in
    // flight will be answered. Taken here rather than by the endpoint, which
    // both ends run, because only a Client is ever told.
    if (receipt.kind === 'control' && isSessionEndV1(receipt.value)) {
      this.#goodbye = receipt.value;
      this.loseBurrow(this.#messages.ended, { endedByBurrow: true });
      return null;
    }
    // A keepalive is accepted and ignored; any other control message is one of
    // the direct path's signals, which the endpoint reads off this receipt —
    // and ignores when it is a shape it does not know.
    if (receipt.kind !== 'app') return receipt;
    for (const message of receipt.messages) {
      let payload: unknown;
      try {
        payload = JSON.parse(utf8Decode(message));
      } catch {
        continue;
      }
      this.#onMsg(payload);
    }
    return receipt;
  }

  #onMsg(data: unknown): void {
    const response = data as RemoteResponse;
    if (response && typeof response.requestId === 'string') {
      const pending = this.#pending.get(response.requestId);
      if (!pending) return;
      this.#pending.delete(response.requestId);
      if (response.ok) pending.resolve(response.result);
      else pending.reject(new Error(response.error ?? 'request failed'));
      return;
    }
    const event = data as RemoteEventMsg;
    if (event && typeof event.subId === 'string') {
      this.#events.get(event.subId)?.(event);
    }
  }

  // --- Endings -------------------------------------------------------------

  /**
   * Everything a session's end does short of the owner's socket: dispose it,
   * fail everything in flight, and — where `notifyGone` — report burrow loss.
   */
  endSession(
    reason: string,
    { notifyGone, endedByBurrow = false }: { notifyGone: boolean; endedByBurrow?: boolean },
  ): void {
    // An {@link awaitDirect} in flight hears how the session ended.
    this.#settleDirect(!notifyGone ? 'retired' : endedByBurrow ? 'ended-by-burrow' : 'lost');
    this.disposeSession();
    this.rejectAll(new Error(reason));
    if (notifyGone) this.#onBurrowGone?.(endedByBurrow);
  }

  /** Erase every session's cipher state; a new ceremony starts from a handshake. */
  disposeSession(): void {
    this.#cancelKeepaliveTimer();
    // The peer connection is this session's: every disposal path closes it, so
    // none can outlive the session that authorized it.
    const direct = this.#established?.direct ?? null;
    direct?.dispose();
    // The endpoint's "announce only what changed" ends with the endpoint, while
    // the subscriber outlives it and the next session's fresh endpoint announces
    // nothing until something changes. Without this, the reason *this* session
    // stayed relayed would sit in the indicator through the whole of the next.
    if (direct?.relayCause) this.#onTransportChanged?.('relay', null);
    this.#established = null;
    this.#settleDirect('retired');
    this.#watchVisibility();
  }

  /** Fail every awaited ceremony frame and in-flight request (avoids hangs). */
  rejectAll(error: Error): void {
    for (const waiter of this.#waiters.values()) waiter.reject(error);
    this.#waiters.clear();
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

/** A ceremony frame is awaited by its kind, its id, **and** its step. */
function waiterKey(kind: string, id: string, step: string): string {
  return `${kind}:${id}:${step}`;
}

/** Internal: a deadline expired with no answer. Never reaches the UI as itself. */
class BurrowUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BurrowUnavailableError';
  }
}

function uuid(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * The browser's own visibility, as {@link PageVisibility}.
 *
 * A runtime with no `document` — a test, a worker — reads as visible: the
 * alternative is a client that silently never keepalives, and the only place
 * this default runs is the app, which always has one.
 */
function documentVisibility(): PageVisibility {
  const doc: Document | undefined = globalThis.document;
  return {
    isVisible: () => doc === undefined || doc.visibilityState === 'visible',
    subscribe(onChange) {
      if (!doc) return () => {};
      doc.addEventListener('visibilitychange', onChange);
      return () => doc.removeEventListener('visibilitychange', onChange);
    },
  };
}

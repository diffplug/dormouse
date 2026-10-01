/**
 * The one-time rendezvous, in memory: Hosted's `OneTimeRoom` as
 * `docs/specs/one-time.md` states its contract ("Wire contract" and "Hosted
 * rendezvous").
 *
 * Test-only, and shared for the reason `test-relay.ts` is: the laptop's
 * `OneTimeRuntime` and the phone's one-time client both have to be driven
 * against *the same* idea of what a room does, and two private copies would be
 * two opinions about which messages reach whom. Nothing mechanically ties this
 * copy to the Durable Object; an edit to either belongs in both.
 *
 * What it models, and all it models:
 *
 * - **A room per Burrow socket**, announced by exactly one `one-time-room` frame
 *   the moment the socket opens.
 * - **One join, ever.** A refused join is accepted and then closed: an
 *   unknown or deleted room `4012`, then a joined one `4011`, then one past its
 *   `expiresAt` `4010`.
 * - **Strings forwarded verbatim, never parsed**, each counted toward
 *   `MAX_ONE_TIME_FORWARDED` across both directions; a message with nobody on
 *   the other end yet is counted, then dropped.
 * - **`RELAY_PING` answered with `RELAY_PONG`**, never forwarded or
 *   counted.
 * - **A non-string, an oversize string, or one past the cap closes both
 *   `4015`.**
 * - **Either end closing sends the other `4013`** and deletes the room.
 * - **The hard deadline** at `expiresAt + ONE_TIME_EXPIRY_GRACE_MS`, on the
 *   injected timer: `4010` to a Burrow nobody joined, `4014` to both ends of a
 *   joined room.
 *
 * Everything it deliberately does not do is the point, as with the relay stub:
 * it keeps no Noise state and learns no outcome, so a connection that succeeds
 * through it succeeded end to end.
 *
 * Below the room is the phone a Burrow-side suite drives through it — a real
 * Noise IK initiator against the link — shared for the same reason: the
 * runtime's suite and the service's both need one, and two would be two
 * opinions about what a phone sends.
 */

import {
  MAX_ONE_TIME_FORWARDED,
  MAX_ONE_TIME_FRAME_LENGTH,
  NoiseTransportSession,
  ONE_TIME_EXPIRY_GRACE_MS,
  ONE_TIME_LINK_TTL_MS,
  RELAY_PING,
  RELAY_PONG,
  ONE_TIME_ROOM_PARAM,
  ONE_TIME_WS_ROUTES,
  WS_CLOSE_ONE_TIME_DEADLINE,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_PEER_GONE,
  WS_CLOSE_ONE_TIME_TAKEN,
  WS_CLOSE_ONE_TIME_UNAVAILABLE,
  WS_CLOSE_ONE_TIME_VIOLATION,
  createNoiseInitiator,
  fromBase64Url,
  generateNoiseKeyPair,
  oneTimeLinkPrologue,
  parseOneTimeLinkUrl,
  toBase64Url,
  utf8Encode,
  type NoiseHandshake,
  type OneTimeBurrowFrame,
  type OneTimeClientFrame,
  type OneTimeLink,
  type OneTimeRoomFrame,
} from 'remote-lib-common';

import type { OneTimeState } from './burrow/one-time-runtime';
import { DirectPeer } from './direct/direct-peer';
import type { FakeDirectNetwork } from './direct/test-fake-peer';
import { FakeEventTarget } from './test-fake-socket';
import { flushUntil, openReceipt, testRoutingId } from './test-e2e-client';
import { realTimer, type RemoteTimer, type RemoteWebSocket } from './ws';

/**
 * One end of a room: a {@link RemoteWebSocket} that carries raw strings, since
 * the room never parses what it forwards and a ping is not JSON.
 */
export class RendezvousSocket implements RemoteWebSocket {
  /** `CONNECTING` until the room accepts it, as a real socket is. */
  readyState = 0;
  /** Every message this end was asked to send, verbatim. */
  readonly sent: unknown[] = [];
  /** Every message the room delivered to this end, verbatim, in order. */
  readonly received: unknown[] = [];
  /** The code this socket closed with, or `null` while it has not. */
  closeCode: number | null = null;
  /** The room's hooks; see {@link TestRendezvous}. */
  onSend: ((data: unknown) => void) | null = null;
  onClose: (() => void) | null = null;
  readonly #events = new FakeEventTarget();

  addEventListener(type: string, handler: (ev: unknown) => void): void {
    this.#events.addEventListener(type, handler);
  }

  /** A real socket throws while connecting and silently drops once closed. */
  send(data: string): void {
    if (this.readyState === 0) throw new Error('the socket is not open yet');
    if (this.readyState !== 1) return;
    this.sent.push(data);
    this.onSend?.(data);
  }

  /** Close from this end: its own close event, then the room's reaction. */
  close(code = 1000): void {
    if (this.readyState >= 2) return;
    const onClose = this.onClose;
    this.#finish(code);
    onClose?.();
  }

  /** The room accepted the socket. */
  open(): void {
    if (this.readyState !== 0) return;
    this.readyState = 1;
    this.#events.emit('open', {});
  }

  /** One message from the room, delivered as the far end sent it. */
  deliver(data: unknown): void {
    if (this.readyState !== 1) return;
    this.received.push(data);
    this.#events.emit('message', { data });
  }

  /** The room, or the network, closed this socket with `code`. */
  closeWith(code: number): void {
    if (this.readyState >= 2) return;
    this.#finish(code);
  }

  /** Every received message that parses as JSON, for a case reading frames. */
  frames(): Array<Record<string, unknown>> {
    return jsonFrames(this.received);
  }

  /** Every message this end sent that parses as JSON: its frames, without the pings. */
  sentFrames(): Array<Record<string, unknown>> {
    return jsonFrames(this.sent);
  }

  #finish(code: number): void {
    this.readyState = 3;
    this.closeCode = code;
    this.onSend = null;
    this.onClose = null;
    this.#events.emit('close', { code });
  }
}

/** The messages in `log` that parse as JSON; a ping, a pong, or garbage is skipped. */
function jsonFrames(log: readonly unknown[]): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const data of log) {
    if (typeof data !== 'string') continue;
    try {
      out.push(JSON.parse(data) as Record<string, unknown>);
    } catch {
      // a ping or a pong, or something a hostile room made up
    }
  }
  return out;
}

/** One room, as a case reads what happened in it. */
export interface TestRoom {
  readonly roomId: string;
  /** Epoch ms after which no phone may join; what the room frame announced. */
  readonly expiresAt: number;
  /** The URL the Burrow opened, so a case can check the route and the scheme. */
  readonly burrowUrl: string;
  readonly burrow: RendezvousSocket;
  readonly client: RendezvousSocket | null;
  /** Messages forwarded, both directions together. */
  readonly forwarded: number;
  /** Whether the room is gone: a close, a violation, or the deadline. */
  readonly deleted: boolean;
}

export interface TestRendezvousOptions {
  readonly now?: () => number;
  /** The room's hard-deadline timer; pass a test clock's to fire it by advancing. */
  readonly setTimer?: RemoteTimer;
  /**
   * What each room announces as its `expiresAt`, from the room's clock; `now +
   * ONE_TIME_LINK_TTL_MS` by default.
   */
  readonly expiresAt?: (now: number) => number;
  /**
   * Whether a room announces itself (default true). `false` models a room that
   * accepted the socket and then said nothing; a case can then deliver
   * whatever it likes through {@link TestRoom.burrow}.
   */
  readonly announce?: boolean;
}

export interface TestRendezvous {
  /** Pass as `OneTimeRuntime`'s `createWebSocket`: every call mints a room. */
  createBurrowSocket(url: string): RendezvousSocket;
  /** The phone's join, by the client route's URL (`…?room=<roomId>`). */
  createClientSocket(url: string): RendezvousSocket;
  /** The client route's URL for `roomId`, on this rendezvous's origin. */
  clientUrl(roomId: string): string;
  /** Every room minted, in order, deleted ones included. */
  readonly rooms: readonly TestRoom[];
  /** The latest room; throws where none was minted. */
  room(): TestRoom;
  /** Fire `roomId`'s hard deadline now, as its alarm would. */
  expire(roomId: string): void;
}

/** One room's mutable state; {@link TestRoom} is its read-only face. */
interface Room {
  roomId: string;
  expiresAt: number;
  burrowUrl: string;
  burrow: RendezvousSocket;
  client: RendezvousSocket | null;
  forwarded: number;
  deleted: boolean;
  cancelDeadline: (() => void) | null;
}

export function createTestRendezvous(options: TestRendezvousOptions = {}): TestRendezvous {
  const now = options.now ?? (() => Date.now());
  const setTimer = options.setTimer ?? realTimer;
  const announce = options.announce ?? true;
  const expiresAtFor = options.expiresAt ?? ((at: number) => at + ONE_TIME_LINK_TTL_MS);
  const rooms: Room[] = [];
  let origin = 'wss://rendezvous.invalid';

  const remove = (room: Room): void => {
    room.deleted = true;
    room.cancelDeadline?.();
    room.cancelDeadline = null;
  };

  const violate = (room: Room): void => {
    remove(room);
    room.burrow.closeWith(WS_CLOSE_ONE_TIME_VIOLATION);
    room.client?.closeWith(WS_CLOSE_ONE_TIME_VIOLATION);
  };

  const forward = (room: Room, from: RendezvousSocket, data: unknown): void => {
    if (room.deleted) return;
    if (data === RELAY_PING) {
      from.deliver(RELAY_PONG);
      return;
    }
    if (typeof data !== 'string' || data.length > MAX_ONE_TIME_FRAME_LENGTH) {
      violate(room);
      return;
    }
    room.forwarded += 1;
    if (room.forwarded > MAX_ONE_TIME_FORWARDED) {
      violate(room);
      return;
    }
    (from === room.burrow ? room.client : room.burrow)?.deliver(data);
  };

  const closed = (room: Room, from: RendezvousSocket): void => {
    if (room.deleted) return;
    remove(room);
    const other = from === room.burrow ? room.client : room.burrow;
    other?.closeWith(WS_CLOSE_ONE_TIME_PEER_GONE);
  };

  const deadline = (room: Room): void => {
    if (room.deleted) return;
    remove(room);
    if (!room.client) {
      room.burrow.closeWith(WS_CLOSE_ONE_TIME_EXPIRED);
      return;
    }
    room.burrow.closeWith(WS_CLOSE_ONE_TIME_DEADLINE);
    room.client.closeWith(WS_CLOSE_ONE_TIME_DEADLINE);
  };

  const find = (roomId: string): Room | undefined => rooms.find((room) => room.roomId === roomId);

  return {
    createBurrowSocket(url) {
      const parsed = new URL(url);
      if (parsed.pathname !== ONE_TIME_WS_ROUTES.burrow) {
        throw new Error(`not the Burrow route: ${url}`);
      }
      origin = `${parsed.protocol}//${parsed.host}`;
      const socket = new RendezvousSocket();
      const mintedAt = now();
      const room: Room = {
        roomId: testRoutingId(),
        expiresAt: expiresAtFor(mintedAt),
        burrowUrl: url,
        burrow: socket,
        client: null,
        forwarded: 0,
        deleted: false,
        cancelDeadline: null,
      };
      rooms.push(room);
      room.cancelDeadline = setTimer(
        () => {
          room.cancelDeadline = null;
          deadline(room);
        },
        Math.max(0, room.expiresAt + ONE_TIME_EXPIRY_GRACE_MS - mintedAt),
      );
      socket.onSend = (data) => forward(room, socket, data);
      socket.onClose = () => closed(room, socket);
      // After the caller's listeners are registered, never before.
      queueMicrotask(() => {
        socket.open();
        if (!announce || room.deleted) return;
        const frame: OneTimeRoomFrame = {
          t: 'one-time-room',
          roomId: room.roomId,
          expiresAt: room.expiresAt,
        };
        socket.deliver(JSON.stringify(frame));
      });
      return socket;
    },

    createClientSocket(url) {
      const parsed = new URL(url);
      if (parsed.pathname !== ONE_TIME_WS_ROUTES.client) {
        throw new Error(`not the client route: ${url}`);
      }
      const socket = new RendezvousSocket();
      const room = find(parsed.searchParams.get(ONE_TIME_ROOM_PARAM) ?? '');
      // Decided now, so a second join made in the same turn is refused; told
      // after the open, as accept-then-close does.
      let refusal: number | null = null;
      if (!room || room.deleted) refusal = WS_CLOSE_ONE_TIME_UNAVAILABLE;
      else if (room.client) refusal = WS_CLOSE_ONE_TIME_TAKEN;
      else if (now() > room.expiresAt) refusal = WS_CLOSE_ONE_TIME_EXPIRED;
      else {
        room.client = socket;
        socket.onSend = (data) => forward(room, socket, data);
        socket.onClose = () => closed(room, socket);
      }
      queueMicrotask(() => {
        socket.open();
        if (refusal !== null) socket.closeWith(refusal);
      });
      return socket;
    },

    clientUrl(roomId) {
      const room = encodeURIComponent(roomId);
      return `${origin}${ONE_TIME_WS_ROUTES.client}?${ONE_TIME_ROOM_PARAM}=${room}`;
    },

    get rooms() {
      return rooms;
    },

    room() {
      const room = rooms[rooms.length - 1];
      if (!room) throw new Error('no room was minted');
      return room;
    },

    expire(roomId) {
      const room = find(roomId);
      if (room) deadline(room);
    },
  };
}

// --- The phone, as a Burrow-side suite drives it ------------------------------

/** One `one-time` frame's text, as either end puts it on its socket. */
export function oneTimeFrameText(
  step: OneTimeClientFrame['step'] | OneTimeBurrowFrame['step'],
  ciphertext: Uint8Array | string,
): string {
  const ct = typeof ciphertext === 'string' ? ciphertext : toBase64Url(ciphertext);
  return JSON.stringify({ t: 'one-time', step, ct });
}

/**
 * Open `runtime` and read its link back the way a phone does: parsed from the
 * `waiting` URL against `origin`, at `now` once the open settled. Throws where
 * it did not settle at `waiting`, or the link did not parse.
 */
export async function openOneTimeLink(
  runtime: { open(): Promise<OneTimeState> },
  origin: string,
  now: () => number,
): Promise<OneTimeLink> {
  const state = await runtime.open();
  if (state.status !== 'waiting') throw new Error(`expected waiting, got ${state.status}`);
  const link = await parseOneTimeLinkUrl(state.url, origin, now());
  if (!link) throw new Error('the link did not parse');
  return link;
}

/** Why `runtime` ended, or `null` while it has not. */
export function oneTimeEndReason(runtime: { readonly state: OneTimeState }): string | null {
  const state = runtime.state;
  return state.status === 'ended' ? state.reason : null;
}

/** A phone's message 1 against `link`, under `prologue` where a case forges one. */
export async function oneTimeInitiator(
  link: OneTimeLink,
  prologue = oneTimeLinkPrologue(link),
): Promise<NoiseHandshake> {
  return await createNoiseInitiator({
    prologue,
    staticKeyPair: await generateNoiseKeyPair(),
    remoteStaticPublicKey: link.ephPub,
  });
}

/**
 * The phone, on its own rendezvous socket, after a completed handshake: reads
 * the Burrow's transport frames in order, which is the only order its receive
 * nonce accepts.
 */
export class TestOneTimePhone {
  #read = 0;

  constructor(
    readonly socket: RendezvousSocket,
    readonly session: NoiseTransportSession,
  ) {}

  sendControl(value: Record<string, unknown>): void {
    this.socket.send(oneTimeFrameText('transport', this.session.sendControl(value)));
  }

  /** One protocol-v1 message on the rendezvous — which the Burrow must refuse. */
  sendApp(payload: unknown): void {
    for (const ct of this.session.sendApp(utf8Encode(JSON.stringify(payload)))) {
      this.socket.send(oneTimeFrameText('transport', ct));
    }
  }

  /** The next Burrow->phone transport message off the rendezvous, opened. */
  async next(): Promise<unknown> {
    const frame = await flushUntil(
      () => this.socket.frames().filter((f) => f.step === 'transport')[this.#read],
    );
    this.#read += 1;
    return openReceipt(this.session, fromBase64Url(frame.ct as string));
  }
}

/** Join `link`'s room on `rendezvous`, send message 1, and read message 2. */
export async function joinOneTimeRoom(
  rendezvous: TestRendezvous,
  link: OneTimeLink,
): Promise<TestOneTimePhone> {
  const socket = rendezvous.createClientSocket(rendezvous.clientUrl(link.roomId));
  await flushUntil(() => (socket.readyState === 1 ? true : undefined));
  const handshake = await oneTimeInitiator(link);
  socket.send(oneTimeFrameText('init', await handshake.writeMessage()));
  const response = await flushUntil(() => socket.frames().find((f) => f.step === 'response'));
  await handshake.readMessage(fromBase64Url(response.ct as string));
  return new TestOneTimePhone(socket, new NoiseTransportSession(handshake.session));
}

/**
 * The phone's offer and the Burrow's reply to it, accepted where it is an
 * answer. `reply` is that first message, whatever it was.
 */
export async function offerOneTimeDirect(
  phone: TestOneTimePhone,
  network: FakeDirectNetwork,
  setTimer?: RemoteTimer,
): Promise<{ peer: DirectPeer; inbound: Uint8Array[]; reply: Record<string, unknown> }> {
  const inbound: Uint8Array[] = [];
  const peer = new DirectPeer({
    peer: network.createOfferer(),
    ...(setTimer ? { setTimer } : {}),
    handlers: {
      onOpen: () => {},
      onFrame: (frame) => void inbound.push(frame),
      onClosed: () => {},
      onViolation: () => {},
    },
  });
  const offer = await peer.offer();
  if (offer === null) throw new Error('the test peer could not describe an offer');
  phone.sendControl({ v: 1, t: 'direct-offer', sdp: offer });
  const reply = (await phone.next()) as Record<string, unknown>;
  if (reply.t === 'direct-answer') await peer.acceptAnswer(reply.sdp as string);
  return { peer, inbound, reply };
}

/**
 * The phone's half of the direct path, up to the Burrow's own switch: offer,
 * answer, and the channel open. The phone's own `direct-switch` is the
 * caller's to send. Throws where the Burrow declines, or answers the offer
 * with anything but its switch after the answer.
 */
export async function negotiateOneTimeDirect(
  phone: TestOneTimePhone,
  network: FakeDirectNetwork,
  setTimer?: RemoteTimer,
): Promise<{ peer: DirectPeer; inbound: Uint8Array[] }> {
  const { peer, inbound, reply } = await offerOneTimeDirect(phone, network, setTimer);
  if (reply.t !== 'direct-answer') throw new Error(`expected an answer, got ${String(reply.t)}`);
  // The Burrow's switch is its last message on the rendezvous.
  const switched = (await phone.next()) as Record<string, unknown>;
  if (switched.v !== 1 || switched.t !== 'direct-switch' || Object.keys(switched).length !== 2) {
    throw new Error(`expected the Burrow's switch, got ${JSON.stringify(switched)}`);
  }
  return { peer, inbound };
}

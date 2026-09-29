/**
 * The laptop's half of a one-time connection, driven by a **real** Noise IK
 * initiator through the in-memory rendezvous (`../test-rendezvous.ts`) and, for
 * the session, the in-memory direct path (`../direct/test-fake-peer.ts`): no
 * ceremony step is stubbed (`docs/specs/one-time.md` -> "Burrow runtime";
 * `docs/specs/remote-security-model.md` -> "One-time connection").
 *
 * Every deadline runs on one injected test clock, shared by the runtime, the
 * room, and the phone's peer, so expiry is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  E2E_INIT_BURST,
  E2E_INIT_REFILL_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  MAX_ONE_TIME_FORWARDED,
  MAX_ONE_TIME_FRAME_LENGTH,
  NoiseTransportSession,
  ONE_TIME_DIRECT_DEADLINE_MS,
  ONE_TIME_EXPIRY_GRACE_MS,
  ONE_TIME_LINK_TTL_MS,
  ONE_TIME_PING,
  ONE_TIME_PONG,
  TokenBucket,
  boundedPairingLabel,
  createNoiseInitiator,
  fromBase64Url,
  generateNoiseKeyPair,
  oneTimeLinkPrologue,
  parseOneTimeLinkUrl,
  toBase64Url,
  utf8Encode,
  type NoiseHandshake,
  type OneTimeLink,
} from 'remote-lib-common';

import {
  OneTimeRuntime,
  ONE_TIME_OPEN_TIMEOUT_MS,
  ONE_TIME_PING_INTERVAL_MS,
  type OneTimeApprovalRequest,
  type OneTimeRuntimeOptions,
  type OneTimeState,
} from './one-time-runtime';
import type { RemoteApiSessionLike } from './established-session';
import { DirectPeer, type DirectPeerFactory } from '../direct/direct-peer';
import {
  FakeDirectNetwork,
  type FakeDirectNetworkOptions,
  type FakePeer,
} from '../direct/test-fake-peer';
import {
  FORGED_CT,
  flushUntil,
  openReceipt,
  pollFor,
  settle,
  settleUntil,
  testRoutingId,
} from '../test-e2e-client';
import {
  createTestRendezvous,
  type RendezvousSocket,
  type TestRendezvous,
  type TestRendezvousOptions,
} from '../test-rendezvous';
import { createTestClock, type TestClock } from '../test-timers';

const ORIGIN = 'https://hosted.example';
const START = 1_700_000_000_000;
const BURROW_LABEL = 'Ned’s laptop';
const CODE = '42';

/** One remote-api handler the runtime built, as the case reads it back. */
interface ServedApi {
  readonly burrowId: string;
  readonly handled: unknown[];
  disposed: boolean;
  send(payload: unknown): void;
}

let clock: TestClock;
let rendezvous: TestRendezvous;
let runtime: OneTimeRuntime;
let states: OneTimeState[];
let approvals: OneTimeApprovalRequest[];
let dismissals: number;
let apis: ServedApi[];
/** The Burrow's peer connections, so a case can see one closed. */
let answerers: FakePeer[];
let network: FakeDirectNetwork;

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clock = createTestClock(START);
  states = [];
  approvals = [];
  dismissals = 0;
  apis = [];
  answerers = [];
  network = new FakeDirectNetwork();
});

afterEach(() => {
  runtime?.end();
  vi.restoreAllMocks();
});

function makeRuntime(
  options: {
    rendezvous?: TestRendezvousOptions;
    network?: FakeDirectNetworkOptions;
    createDirectPeer?: DirectPeerFactory | null;
  } & Partial<Pick<OneTimeRuntimeOptions, 'burrowLabel'>> = {},
): OneTimeRuntime {
  rendezvous = createTestRendezvous({ now: clock.now, setTimer: clock.setTimer, ...options.rendezvous });
  if (options.network) network = new FakeDirectNetwork(options.network);
  const createDirectPeer =
    options.createDirectPeer === undefined
      ? () => {
          const peer = network.createAnswerer();
          answerers.push(peer);
          return peer;
        }
      : options.createDirectPeer;
  runtime = new OneTimeRuntime({
    origin: ORIGIN,
    createWebSocket: (url) => rendezvous.createBurrowSocket(url),
    createSession: ({ burrowId, send }) => {
      const api: ServedApi = { burrowId, handled: [], disposed: false, send };
      apis.push(api);
      return {
        handle: (payload) => void api.handled.push(payload),
        dispose: () => {
          api.disposed = true;
        },
      } satisfies RemoteApiSessionLike;
    },
    createDirectPeer,
    burrowLabel: options.burrowLabel ?? BURROW_LABEL,
    requestApproval: (request) => void approvals.push(request),
    dismissApproval: () => void (dismissals += 1),
    onChange: (state) => void states.push(state),
    now: clock.now,
    setTimer: clock.setTimer,
  });
  return runtime;
}

/** Open the runtime and read its link back the way a phone does. */
async function openLink(): Promise<OneTimeLink> {
  const state = await runtime.open();
  if (state.status !== 'waiting') throw new Error(`expected waiting, got ${state.status}`);
  const link = await parseOneTimeLinkUrl(state.url, ORIGIN, clock.now());
  if (!link) throw new Error('the link did not parse');
  return link;
}

/** One `one-time` frame, as a phone puts it on its socket. */
function frameText(step: 'init' | 'transport', ciphertext: Uint8Array | string): string {
  const ct = typeof ciphertext === 'string' ? ciphertext : toBase64Url(ciphertext);
  return JSON.stringify({ t: 'one-time', step, ct });
}

/** The Burrow's own frames of one step, off its socket's send log, whether or not anyone got them. */
function burrowSent(step: 'response' | 'transport'): Array<Record<string, unknown>> {
  return rendezvous
    .room()
    .burrow.sent.filter((data): data is string => typeof data === 'string' && data !== ONE_TIME_PING)
    .map((data) => JSON.parse(data) as Record<string, unknown>)
    .filter((frame) => frame.step === step);
}

/** A phone's message 1 against `link`, under `prologue` when a case forges one. */
async function initiator(link: OneTimeLink, prologue = oneTimeLinkPrologue(link)): Promise<NoiseHandshake> {
  return await createNoiseInitiator({
    prologue,
    staticKeyPair: await generateNoiseKeyPair(),
    remoteStaticPublicKey: link.ephPub,
  });
}

/** Deliver `text` to the Burrow as the room would, whatever the room is. */
function fromRoom(text: string): void {
  rendezvous.room().burrow.deliver(text);
}

/**
 * The phone, on its own rendezvous socket, after a completed handshake: reads
 * the Burrow's transport frames in order, which is the only order its receive
 * nonce accepts.
 */
class TestPhone {
  #read = 0;

  constructor(
    readonly socket: RendezvousSocket,
    readonly session: NoiseTransportSession,
  ) {}

  sendControl(value: Record<string, unknown>): void {
    this.socket.send(frameText('transport', this.session.sendControl(value)));
  }

  /** One protocol-v1 message on the rendezvous — which the Burrow must refuse. */
  sendApp(payload: unknown): void {
    for (const ct of this.session.sendApp(utf8Encode(JSON.stringify(payload)))) {
      this.socket.send(frameText('transport', ct));
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

/** Join the room, send message 1, and read message 2. */
async function joinPhone(link: OneTimeLink): Promise<TestPhone> {
  const socket = rendezvous.createClientSocket(rendezvous.clientUrl(link.roomId));
  await flushUntil(() => (socket.readyState === 1 ? true : undefined));
  const handshake = await initiator(link);
  socket.send(frameText('init', await handshake.writeMessage()));
  const response = await flushUntil(() => socket.frames().find((f) => f.step === 'response'));
  await handshake.readMessage(fromBase64Url(response.ct as string));
  return new TestPhone(socket, new NoiseTransportSession(handshake.session));
}

/** Everything up to the approval modal. */
async function confirming(label = 'iPhone Safari'): Promise<{
  link: OneTimeLink;
  phone: TestPhone;
  approval: OneTimeApprovalRequest;
}> {
  const link = await openLink();
  const phone = await joinPhone(link);
  phone.sendControl({ code: CODE, label });
  await settleUntil(() => approvals.length > 0);
  const approval = approvals[0];
  if (!approval) throw new Error('no approval was requested');
  return { link, phone, approval };
}

/** Confirmed: the outcome is read, and the session awaits its direct path. */
async function connecting(): Promise<{ link: OneTimeLink; phone: TestPhone }> {
  const { link, phone, approval } = await confirming();
  approval.approve(CODE);
  expect(await phone.next()).toEqual({ ok: true, burrowLabel: BURROW_LABEL });
  return { link, phone };
}

/**
 * The phone's half of the direct path, up to the Burrow's own switch: offer,
 * answer, and the channel open.
 */
async function negotiateDirect(phone: TestPhone): Promise<{ peer: DirectPeer; inbound: Uint8Array[] }> {
  const inbound: Uint8Array[] = [];
  const peer = new DirectPeer({
    peer: network.createOfferer(),
    setTimer: clock.setTimer,
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
  const answer = (await phone.next()) as Record<string, unknown>;
  if (answer.t !== 'direct-answer') throw new Error(`expected an answer, got ${String(answer.t)}`);
  await peer.acceptAnswer(answer.sdp as string);
  // The Burrow's switch is its last message on the rendezvous.
  expect(await phone.next()).toEqual({ v: 1, t: 'direct-switch' });
  return { peer, inbound };
}

/** All the way to `connected`. */
async function connected(): Promise<{
  link: OneTimeLink;
  phone: TestPhone;
  peer: DirectPeer;
  inbound: Uint8Array[];
}> {
  const { link, phone } = await connecting();
  const { peer, inbound } = await negotiateDirect(phone);
  phone.sendControl({ v: 1, t: 'direct-switch' });
  await settleUntil(() => runtime.state.status === 'connected');
  expect(runtime.state.status).toBe('connected');
  return { link, phone, peer, inbound };
}

/** One protocol-v1 message on the channel, as the switched phone sends it. */
function sendOnChannel(phone: TestPhone, peer: DirectPeer, payload: unknown): void {
  for (const ct of phone.session.sendApp(utf8Encode(JSON.stringify(payload)))) peer.send(ct);
}

function endedWith(): string | null {
  const state = runtime.state;
  return state.status === 'ended' ? state.reason : null;
}

describe('OneTimeRuntime: the link', () => {
  it('opens the Burrow route and shows a link a phone parses back', async () => {
    makeRuntime();
    const link = await openLink();
    const room = rendezvous.room();
    expect(room.burrowUrl).toBe('wss://hosted.example/api/one-time/burrow');
    expect(link.roomId).toBe(room.roomId);
    expect(link.ephPub).toHaveLength(32);
    expect(states.map((s) => s.status)).toEqual(['opening', 'waiting']);
    const waiting = runtime.state;
    expect(waiting).toMatchObject({ status: 'waiting', expiresAt: link.expiry * 1000 });
  });

  it('advertises the earlier of its own TTL and the room’s expiry, in whole seconds', async () => {
    makeRuntime({ rendezvous: { expiresAt: (now) => now + 60_500 } });
    expect((await openLink()).expiry).toBe(Math.floor((START + 60_500) / 1000));
    runtime.end();

    makeRuntime({ rendezvous: { expiresAt: (now) => now + 10 * ONE_TIME_LINK_TTL_MS } });
    expect((await openLink()).expiry).toBe(Math.floor((START + ONE_TIME_LINK_TTL_MS) / 1000));
  });

  it('ends unreachable when the room never announces itself', async () => {
    makeRuntime({ rendezvous: { announce: false } });
    const opened = runtime.open();
    await flushUntil(() => (rendezvous.rooms.length > 0 ? true : undefined));
    clock.advance(ONE_TIME_OPEN_TIMEOUT_MS - 1);
    expect(runtime.state.status).toBe('opening');
    clock.advance(1);
    expect(await opened).toEqual({ status: 'ended', reason: 'unreachable' });
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
  });

  it('ends unreachable when the room’s first message is not a room frame', async () => {
    makeRuntime({ rendezvous: { announce: false } });
    const opened = runtime.open();
    await flushUntil(() => (rendezvous.rooms[0]?.burrow.readyState === 1 ? true : undefined));
    fromRoom(JSON.stringify({ t: 'one-time-room', roomId: 'short', expiresAt: START }));
    expect(await opened).toEqual({ status: 'ended', reason: 'unreachable' });
  });

  it('ends unreachable when the socket closes before a room', async () => {
    makeRuntime({ rendezvous: { announce: false } });
    const opened = runtime.open();
    await flushUntil(() => (rendezvous.rooms[0]?.burrow.readyState === 1 ? true : undefined));
    rendezvous.room().burrow.closeWith(1006);
    expect(await opened).toEqual({ status: 'ended', reason: 'unreachable' });
  });

  it('opens once', async () => {
    makeRuntime();
    await openLink();
    await expect(runtime.open()).rejects.toThrow(/opens once/);
  });

  it('pings the rendezvous while it waits, and neither counts nor parses the answers', async () => {
    makeRuntime();
    const link = await openLink();
    clock.advance(ONE_TIME_PING_INTERVAL_MS);
    const room = rendezvous.room();
    expect(room.burrow.sent).toEqual([ONE_TIME_PING]);
    expect(room.burrow.received).toContain(ONE_TIME_PONG);
    // More answers than the message cap: none of them counts against it.
    for (let i = 0; i <= MAX_ONE_TIME_FORWARDED; i += 1) fromRoom(ONE_TIME_PONG);
    expect(runtime.state.status).toBe('waiting');
    await joinPhone(link);
  });

  it('expires a link nobody claimed on its own clock', async () => {
    makeRuntime();
    const link = await openLink();
    clock.advance(link.expiry * 1000 - clock.now());
    expect(runtime.state.status).toBe('waiting');
    clock.advance(1);
    expect(endedWith()).toBe('expired');
    expect(rendezvous.room().deleted).toBe(true);
    expect(clock.armed).toBe(0);
  });
});

describe('OneTimeRuntime: the handshake', () => {
  it('reserves nothing on a message 1 under another prologue', async () => {
    makeRuntime();
    const link = await openLink();
    const forged = await initiator(link, oneTimeLinkPrologue({ ...link, roomId: testRoutingId() }));
    const honest = await initiator(link);
    fromRoom(frameText('init', await forged.writeMessage()));
    fromRoom(frameText('init', await honest.writeMessage()));
    const response = await flushUntil(() => burrowSent('response')[0]);
    // The honest phone's handshake completes against it: the forged one held nothing.
    await honest.readMessage(fromBase64Url(response.ct as string));
    expect(burrowSent('response')).toHaveLength(1);
  });

  it('lets the first valid message 1 reserve the link, and drops a later one uncomputed', async () => {
    makeRuntime();
    const link = await openLink();
    const phone = await joinPhone(link);
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');
    const second = await (await initiator(link)).writeMessage();
    const before = deriveBits.mock.calls.length;
    phone.socket.send(frameText('init', second));
    // The request queues behind it, so its approval proves the init was read.
    phone.sendControl({ code: CODE, label: 'iPhone Safari' });
    await settleUntil(() => approvals.length > 0);
    expect(deriveBits.mock.calls.length).toBe(before);
    expect(burrowSent('response')).toHaveLength(1);
  });

  it('spends a token from the init bucket before any WebCrypto', async () => {
    makeRuntime();
    const link = await openLink();
    const take = vi.spyOn(TokenBucket.prototype, 'take');
    for (let i = 0; i < E2E_INIT_BURST; i += 1) {
      const forged = await initiator(link, oneTimeLinkPrologue({ ...link, roomId: testRoutingId() }));
      fromRoom(frameText('init', await forged.writeMessage()));
    }
    const refused = await initiator(link);
    fromRoom(frameText('init', await refused.writeMessage()));
    await settleUntil(() => take.mock.calls.length === E2E_INIT_BURST + 1);
    expect(burrowSent('response')).toHaveLength(0);

    clock.advance(E2E_INIT_REFILL_INTERVAL_MS);
    const admitted = await initiator(link);
    fromRoom(frameText('init', await admitted.writeMessage()));
    const response = await flushUntil(() => burrowSent('response')[0]);
    // Message 2 answers the admitted handshake, not the one the bucket refused.
    await admitted.readMessage(fromBase64Url(response.ct as string));
  });

  it('measures a frame against the bound before parsing it', async () => {
    makeRuntime();
    const link = await openLink();
    const parse = vi.spyOn(JSON, 'parse');
    const padded = await initiator(link);
    // Valid JSON, and a valid init, one character past the bound.
    const oversize = frameText('init', await padded.writeMessage()).padEnd(
      MAX_ONE_TIME_FRAME_LENGTH + 1,
      ' ',
    );
    fromRoom(oversize);
    expect(parse.mock.calls.some(([text]) => text === oversize)).toBe(false);
    const honest = await initiator(link);
    fromRoom(frameText('init', await honest.writeMessage()));
    const response = await flushUntil(() => burrowSent('response')[0]);
    await honest.readMessage(fromBase64Url(response.ct as string));
  });

  it('stops reading a room that forwards more than a handshake, before queued work runs', async () => {
    makeRuntime();
    await openLink();
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');
    const init = frameText('init', FORGED_CT);
    for (let i = 0; i < MAX_ONE_TIME_FORWARDED; i += 1) fromRoom(init);
    expect(runtime.state.status).toBe('waiting');
    fromRoom(init);
    expect(endedWith()).toBe('burrow-error');
    await settle();
    expect(deriveBits).not.toHaveBeenCalled();
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
  });
});

describe('OneTimeRuntime: the confirmation', () => {
  it('surfaces the request with its label bounded', async () => {
    makeRuntime();
    const raw = `\u001b[31m${'phone'.repeat(40)}\u0007`;
    const { link, approval } = await confirming(raw);
    expect(approval.label).toBe(boundedPairingLabel(raw));
    expect(approval.label.length).toBeLessThanOrEqual(64);
    expect(runtime.state).toEqual({
      status: 'confirming',
      label: approval.label,
      expiresAt: link.expiry * 1000,
    });
  });

  it('ends burrow-error on a first control that is not a request', async () => {
    makeRuntime();
    const link = await openLink();
    const phone = await joinPhone(link);
    phone.sendControl({ hello: 'there' });
    expect(await phone.next()).toEqual({ ok: false, code: 'burrow-error' });
    expect(endedWith()).toBe('burrow-error');
    expect(approvals).toHaveLength(0);
  });

  it('gives the confirmation exactly one attempt', async () => {
    makeRuntime();
    const { phone, approval } = await confirming();
    approval.approve('07');
    expect(await phone.next()).toEqual({ ok: false, code: 'confirmation-mismatch' });
    expect(endedWith()).toBe('confirmation-mismatch');
    approval.approve(CODE);
    await settle();
    expect(burrowSent('transport')).toHaveLength(1);
    expect(apis).toHaveLength(0);
    expect(dismissals).toBe(1);
  });

  it('denies locally', async () => {
    makeRuntime();
    const { phone, approval } = await confirming();
    approval.deny();
    expect(await phone.next()).toEqual({ ok: false, code: 'user-denied' });
    expect(endedWith()).toBe('user-denied');
    expect(dismissals).toBe(1);
  });

  it('surfaces no request that arrives after the link expired', async () => {
    makeRuntime();
    const link = await openLink();
    const phone = await joinPhone(link);
    clock.advance(link.expiry * 1000 + 1 - clock.now());
    phone.sendControl({ code: CODE, label: 'iPhone Safari' });
    expect(await phone.next()).toEqual({ ok: false, code: 'link-expired' });
    expect(endedWith()).toBe('expired');
    expect(approvals).toHaveLength(0);
  });

  it('refuses a confirmation made after the link expired', async () => {
    makeRuntime();
    const { link, phone, approval } = await confirming();
    clock.advance(link.expiry * 1000 + 1 - clock.now());
    approval.approve(CODE);
    expect(await phone.next()).toEqual({ ok: false, code: 'link-expired' });
    expect(endedWith()).toBe('expired');
    expect(apis).toHaveLength(0);
  });

  it('tells a phone still holding the link at the room’s deadline, on its own clock', async () => {
    // A room that would stay open longer: the Burrow's own deadline is what fires.
    makeRuntime({ rendezvous: { expiresAt: (now) => now + ONE_TIME_LINK_TTL_MS + 60_000 } });
    const { link, phone } = await confirming();
    clock.advance(link.expiry * 1000 + ONE_TIME_EXPIRY_GRACE_MS - 1 - clock.now());
    expect(runtime.state.status).toBe('confirming');
    clock.advance(1);
    expect(await phone.next()).toEqual({ ok: false, code: 'link-expired' });
    expect(endedWith()).toBe('expired');
    expect(dismissals).toBe(1);
  });
});

describe('OneTimeRuntime: the session', () => {
  it('serves protocol-v1 only once both directions are direct', async () => {
    makeRuntime();
    const { link, phone } = await connecting();
    expect(runtime.state).toEqual({ status: 'connecting', label: 'iPhone Safari' });
    expect(dismissals).toBe(1);
    // `hello` answers with the room id: there is no enrollment to name.
    expect(apis.map((api) => api.burrowId)).toEqual([link.roomId]);

    const { peer, inbound } = await negotiateDirect(phone);
    expect(runtime.state.status).toBe('connecting');
    phone.sendControl({ v: 1, t: 'direct-switch' });
    await settleUntil(() => runtime.state.status === 'connected');
    expect(runtime.state).toEqual({ status: 'connected', label: 'iPhone Safari', since: clock.now() });
    // The Burrow closed the rendezvous normally, and the room told the phone.
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
    expect(phone.socket.closeCode).toBe(4013);

    sendOnChannel(phone, peer, { requestId: '1', method: 'hello' });
    await settleUntil(() => apis[0]!.handled.length > 0);
    expect(apis[0]!.handled).toEqual([{ requestId: '1', method: 'hello' }]);
    apis[0]!.send({ requestId: '1', ok: true, result: {} });
    await settleUntil(() => inbound.length > 0);
    expect(openReceipt(phone.session, inbound[0]!)).toEqual([{ requestId: '1', ok: true, result: {} }]);
    expect(states.map((s) => s.status)).toEqual([
      'opening',
      'waiting',
      'confirming',
      'connecting',
      'connected',
    ]);
  });

  it('ends the session on an application message over the rendezvous', async () => {
    makeRuntime();
    const { phone } = await connecting();
    phone.sendApp({ requestId: '1', method: 'hello' });
    await settleUntil(() => runtime.state.status === 'ended');
    expect(endedWith()).toBe('burrow-error');
    expect(apis[0]!.handled).toEqual([]);
    expect(apis[0]!.disposed).toBe(true);
  });

  it('declines, tells the phone, then ends direct-failed where it builds no peer', async () => {
    makeRuntime({ createDirectPeer: null });
    const { phone } = await connecting();
    const peer = new DirectPeer({
      peer: network.createOfferer(),
      setTimer: clock.setTimer,
      handlers: { onOpen: () => {}, onFrame: () => {}, onClosed: () => {}, onViolation: () => {} },
    });
    phone.sendControl({ v: 1, t: 'direct-offer', sdp: (await peer.offer())! });
    expect(await phone.next()).toEqual({ v: 1, t: 'direct-decline' });
    await settleUntil(() => runtime.state.status === 'ended');
    expect(endedWith()).toBe('direct-failed');
    expect(phone.socket.closeCode).toBe(4013);
  });

  it('ends direct-failed when no switch lands by the direct deadline', async () => {
    makeRuntime();
    await connecting();
    clock.advance(ONE_TIME_DIRECT_DEADLINE_MS - 1);
    expect(runtime.state.status).toBe('connecting');
    clock.advance(1);
    expect(endedWith()).toBe('direct-failed');
    expect(apis[0]!.disposed).toBe(true);
  });

  it('reads the phone’s switch before the room’s report that the phone left', async () => {
    makeRuntime();
    const { phone } = await connecting();
    const { peer, inbound } = await negotiateDirect(phone);
    // The phone switches and leaves the room in one breath: both reach the
    // Burrow before it has read either.
    phone.sendControl({ v: 1, t: 'direct-switch' });
    phone.socket.close();
    await settleUntil(() => runtime.state.status !== 'connecting');
    expect(runtime.state.status).toBe('connected');

    sendOnChannel(phone, peer, { requestId: '1', method: 'hello' });
    await settleUntil(() => apis[0]!.handled.length > 0);
    apis[0]!.send({ requestId: '1', ok: true, result: {} });
    await settleUntil(() => inbound.length > 0);
    expect(runtime.state.status).toBe('connected');
  });

  it('ends phone-left when the channel is lost after the switch', async () => {
    makeRuntime();
    await connected();
    network.dropChannels();
    await settleUntil(() => runtime.state.status === 'ended');
    expect(endedWith()).toBe('phone-left');
    expect(apis[0]!.disposed).toBe(true);
    expect(answerers[0]!.closed).toBe(true);
  });

  it('reaps an idle session, and a keepalive on the channel defers it', async () => {
    makeRuntime();
    const { phone, peer } = await connected();
    clock.advance(ESTABLISHED_E2E_IDLE_TIMEOUT_MS - 1_000);
    peer.send(phone.session.sendKeepalive());
    await settle();
    clock.advance(1_000);
    expect(runtime.state.status).toBe('connected');
    clock.advance(ESTABLISHED_E2E_IDLE_TIMEOUT_MS);
    expect(endedWith()).toBe('idle');
    expect(answerers[0]!.closed).toBe(true);
    expect(apis[0]!.disposed).toBe(true);
  });
});

describe('OneTimeRuntime: the rendezvous closing before the switch', () => {
  it('ends phone-left when the phone leaves the room, dismissing its request', async () => {
    makeRuntime();
    const { phone } = await confirming();
    phone.socket.close();
    await settleUntil(() => runtime.state.status === 'ended');
    expect(endedWith()).toBe('phone-left');
    expect(dismissals).toBe(1);
  });

  it('ends expired when the room’s deadline passes, joined or not', async () => {
    makeRuntime();
    await openLink();
    rendezvous.expire(rendezvous.room().roomId);
    await settleUntil(() => runtime.state.status === 'ended');
    expect(rendezvous.room().burrow.closeCode).toBe(4010);
    expect(endedWith()).toBe('expired');
    runtime.end();

    makeRuntime();
    await joinPhone(await openLink());
    rendezvous.expire(rendezvous.room().roomId);
    await settleUntil(() => runtime.state.status === 'ended');
    expect(rendezvous.room().burrow.closeCode).toBe(4014);
    expect(endedWith()).toBe('expired');
  });

  it('ends burrow-error when the room closes it for a violation', async () => {
    makeRuntime();
    const phone = await joinPhone(await openLink());
    phone.socket.send('x'.repeat(MAX_ONE_TIME_FRAME_LENGTH + 1));
    await settleUntil(() => runtime.state.status === 'ended');
    expect(rendezvous.room().burrow.closeCode).toBe(4015);
    expect(endedWith()).toBe('burrow-error');
  });

  it('ends rendezvous-lost on a close the room did not name', async () => {
    makeRuntime();
    await openLink();
    rendezvous.room().burrow.closeWith(1006);
    await settleUntil(() => runtime.state.status === 'ended');
    expect(endedWith()).toBe('rendezvous-lost');
  });
});

describe('OneTimeRuntime: end()', () => {
  it('closes the rendezvous and leaves no timer armed', async () => {
    makeRuntime();
    await openLink();
    runtime.end();
    expect(endedWith()).toBe('user-ended');
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
    expect(rendezvous.room().deleted).toBe(true);
    expect(clock.armed).toBe(0);
    runtime.end('idle');
    expect(endedWith()).toBe('user-ended');
  });

  it('dismisses a pending request, and a late approval does nothing', async () => {
    makeRuntime();
    const { approval } = await confirming();
    runtime.end();
    expect(dismissals).toBe(1);
    approval.approve(CODE);
    await settle();
    expect(burrowSent('transport')).toHaveLength(0);
    expect(apis).toHaveLength(0);
  });

  it('disposes a connected session and its peer connection', async () => {
    makeRuntime();
    await connected();
    runtime.end();
    expect(endedWith()).toBe('user-ended');
    expect(apis[0]!.disposed).toBe(true);
    expect(answerers[0]!.closed).toBe(true);
    const lastState = states[states.length - 1];
    expect(lastState).toEqual({ status: 'ended', reason: 'user-ended' });
  });

  it('ends a runtime still opening without ever opening a socket', async () => {
    makeRuntime();
    const opened = runtime.open();
    runtime.end();
    expect(await opened).toEqual({ status: 'ended', reason: 'user-ended' });
    await pollFor(() => undefined, 20);
    expect(rendezvous.rooms).toHaveLength(0);
  });
});

/**
 * The laptop's half of a one-time connection, driven by a **real** Noise IK
 * initiator through the in-memory rendezvous (`../test-rendezvous.ts`) and, for
 * the session, the in-memory direct path (`../direct/test-fake-peer.ts`): no
 * ceremony step is stubbed but one case's stalled key generation
 * (`docs/specs/one-time.md` -> "Burrow runtime";
 * `docs/specs/remote-security-model.md` -> "One-time connection").
 *
 * Every deadline runs on one injected test clock, shared by the runtime, the
 * room, and the phone's peer, so expiry is deterministic.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** A key generation a case stands in for the real one, cleared after each case. */
const keygen = vi.hoisted(() => ({
  override: null as (() => Promise<import('remote-lib-common').NoiseKeyPair>) | null,
}));

vi.mock('remote-lib-common', async (importOriginal) => {
  const real = await importOriginal<typeof import('remote-lib-common')>();
  return {
    ...real,
    generateNoiseKeyPair: () => (keygen.override ?? real.generateNoiseKeyPair)(),
  };
});

import {
  E2E_INIT_BURST,
  E2E_INIT_REFILL_INTERVAL_MS,
  ESTABLISHED_E2E_IDLE_TIMEOUT_MS,
  MAX_ONE_TIME_FORWARDED,
  MAX_ONE_TIME_FRAME_LENGTH,
  DIRECT_ONLY_DEADLINE_MS,
  ONE_TIME_LINK_TTL_MS,
  RELAY_PING,
  RELAY_PING_INTERVAL_MS,
  RELAY_PONG,
  ONE_TIME_UNKNOWN_DEVICE_LABEL,
  TokenBucket,
  fromBase64Url,
  oneTimeLinkPrologue,
  utf8Encode,
  type OneTimeLink,
} from 'remote-lib-common';

import {
  OneTimeRuntime,
  ONE_TIME_OPEN_TIMEOUT_MS,
  type OneTimeApprovalRequest,
  type OneTimeRuntimeOptions,
  type OneTimeState,
} from './one-time-runtime';
import type { RemoteApiSessionLike } from './established-session';
import {
  DIRECT_PATH_RECHECK_MS,
  DirectPeer,
  type DirectPathPolicy,
  type DirectPeerFactory,
} from '../direct/direct-peer';
import {
  FakeDirectNetwork,
  OFF_LAN_PAIR as OFF_LAN,
  collect,
  lanOnlyPolicy,
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
  TestOneTimePhone,
  createTestRendezvous,
  joinOneTimeRoom,
  negotiateOneTimeDirect,
  offerOneTimeDirect,
  oneTimeEndReason,
  oneTimeFrameText,
  oneTimeInitiator,
  openOneTimeLink,
  type TestRendezvous,
  type TestRendezvousOptions,
} from '../test-rendezvous';
import { createTestClock, type TestClock } from '../test-timers';

const ORIGIN = 'https://hosted.example';
const START = 1_700_000_000_000;
const BURROW_LABEL = 'Ned’s laptop';
const CODE = '42';
const PHONE_LABEL = 'iPhone';

/** One remote-api handler the runtime built, as the case reads it back. */
interface ServedApi {
  readonly burrowId: string;
  readonly label: string;
  readonly end: () => void;
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
  keygen.override = null;
  vi.restoreAllMocks();
});

function makeRuntime(
  options: {
    rendezvous?: TestRendezvousOptions;
    network?: FakeDirectNetworkOptions;
    createDirectPeer?: DirectPeerFactory | null;
    pathPolicy?: DirectPathPolicy;
  } & Partial<Pick<OneTimeRuntimeOptions, 'burrowLabel'>> = {},
): OneTimeRuntime {
  rendezvous = createTestRendezvous({ now: clock.now, setTimer: clock.setTimer, ...options.rendezvous });
  if (options.network) network = new FakeDirectNetwork(options.network);
  const createDirectPeer =
    options.createDirectPeer === undefined
      ? collect(answerers, () => network.createAnswerer())
      : options.createDirectPeer;
  runtime = new OneTimeRuntime({
    origin: ORIGIN,
    createWebSocket: (url) => rendezvous.createBurrowSocket(url),
    createSession: ({ burrowId, send, label, end }) => {
      const api: ServedApi = { burrowId, label, end, handled: [], disposed: false, send };
      apis.push(api);
      return {
        handle: (payload) => void api.handled.push(payload),
        dispose: () => {
          api.disposed = true;
        },
      } satisfies RemoteApiSessionLike;
    },
    directPeering: { createPeer: createDirectPeer, pathPolicy: options.pathPolicy },
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
const openLink = (): Promise<OneTimeLink> => openOneTimeLink(runtime, ORIGIN, clock.now);

/** The Burrow's own frames of one step, off its socket's send log, whether or not anyone got them. */
function burrowSent(step: 'response' | 'transport'): Array<Record<string, unknown>> {
  return rendezvous
    .room()
    .burrow.sentFrames()
    .filter((frame) => frame.step === step);
}

/** Deliver `text` to the Burrow as the room would, whatever the room is. */
function fromRoom(text: string): void {
  rendezvous.room().burrow.deliver(text);
}

/** Join the room, send message 1, and read message 2. */
const joinPhone = (link: OneTimeLink): Promise<TestOneTimePhone> => joinOneTimeRoom(rendezvous, link);

/** Everything up to the approval modal. */
async function confirming(label = PHONE_LABEL): Promise<{
  link: OneTimeLink;
  phone: TestOneTimePhone;
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
async function connecting(): Promise<{ link: OneTimeLink; phone: TestOneTimePhone }> {
  const { link, phone, approval } = await confirming();
  approval.approve(CODE);
  expect(await phone.next()).toEqual({ ok: true, burrowLabel: BURROW_LABEL });
  return { link, phone };
}

/** All the way to `connected`. */
async function connected(): Promise<{
  link: OneTimeLink;
  phone: TestOneTimePhone;
  peer: DirectPeer;
  inbound: Uint8Array[];
}> {
  const { link, phone } = await connecting();
  const { peer, inbound } = await negotiateOneTimeDirect(phone, network, clock.setTimer);
  phone.sendControl({ v: 1, t: 'direct-switch' });
  await settleUntil(() => runtime.state.status === 'connected');
  expect(runtime.state.status).toBe('connected');
  return { link, phone, peer, inbound };
}

/** One protocol-v1 message on the channel, as the switched phone sends it. */
function sendOnChannel(phone: TestOneTimePhone, peer: DirectPeer, payload: unknown): void {
  for (const ct of phone.session.sendApp(utf8Encode(JSON.stringify(payload)))) peer.send(ct);
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

  it('ends unreachable at its deadline while key generation stalls, opening no socket', async () => {
    keygen.override = () => new Promise(() => {});
    makeRuntime();
    const opened = runtime.open();
    clock.advance(ONE_TIME_OPEN_TIMEOUT_MS);
    expect(await opened).toEqual({ status: 'ended', reason: 'unreachable' });
    expect(rendezvous.rooms).toHaveLength(0);
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
    clock.advance(RELAY_PING_INTERVAL_MS);
    const room = rendezvous.room();
    expect(room.burrow.sent).toEqual([RELAY_PING]);
    expect(room.burrow.received).toContain(RELAY_PONG);
    // More answers than the message cap: none of them counts against it.
    for (let i = 0; i <= MAX_ONE_TIME_FORWARDED; i += 1) fromRoom(RELAY_PONG);
    expect(runtime.state.status).toBe('waiting');
    await joinPhone(link);
  });

  it('expires a link nobody claimed on its own clock', async () => {
    makeRuntime();
    const link = await openLink();
    clock.advance(link.expiry * 1000 - clock.now());
    expect(runtime.state.status).toBe('waiting');
    clock.advance(1);
    expect(oneTimeEndReason(runtime)).toBe('expired');
    expect(rendezvous.room().deleted).toBe(true);
    expect(clock.armed).toBe(0);
  });
});

describe('OneTimeRuntime: the handshake', () => {
  it('reserves nothing on a message 1 under another prologue', async () => {
    makeRuntime();
    const link = await openLink();
    const forged = await oneTimeInitiator(link, oneTimeLinkPrologue({ ...link, roomId: testRoutingId() }));
    const honest = await oneTimeInitiator(link);
    fromRoom(oneTimeFrameText('init', await forged.writeMessage()));
    fromRoom(oneTimeFrameText('init', await honest.writeMessage()));
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
    const second = await (await oneTimeInitiator(link)).writeMessage();
    const before = deriveBits.mock.calls.length;
    phone.socket.send(oneTimeFrameText('init', second));
    // The request queues behind it, so its approval proves the init was read.
    phone.sendControl({ code: CODE, label: PHONE_LABEL });
    await settleUntil(() => approvals.length > 0);
    expect(deriveBits.mock.calls.length).toBe(before);
    expect(burrowSent('response')).toHaveLength(1);
  });

  it('spends a token from the init bucket before any WebCrypto', async () => {
    makeRuntime();
    const link = await openLink();
    const take = vi.spyOn(TokenBucket.prototype, 'take');
    for (let i = 0; i < E2E_INIT_BURST; i += 1) {
      const forged = await oneTimeInitiator(link, oneTimeLinkPrologue({ ...link, roomId: testRoutingId() }));
      fromRoom(oneTimeFrameText('init', await forged.writeMessage()));
    }
    const refused = await oneTimeInitiator(link);
    fromRoom(oneTimeFrameText('init', await refused.writeMessage()));
    await settleUntil(() => take.mock.calls.length === E2E_INIT_BURST + 1);
    expect(burrowSent('response')).toHaveLength(0);

    clock.advance(E2E_INIT_REFILL_INTERVAL_MS);
    const admitted = await oneTimeInitiator(link);
    fromRoom(oneTimeFrameText('init', await admitted.writeMessage()));
    const response = await flushUntil(() => burrowSent('response')[0]);
    // Message 2 answers the admitted handshake, not the one the bucket refused.
    await admitted.readMessage(fromBase64Url(response.ct as string));
  });

  it('measures a frame against the bound before parsing it', async () => {
    makeRuntime();
    const link = await openLink();
    const parse = vi.spyOn(JSON, 'parse');
    const padded = await oneTimeInitiator(link);
    // Valid JSON, and a valid init, one character past the bound.
    const oversize = oneTimeFrameText('init', await padded.writeMessage()).padEnd(
      MAX_ONE_TIME_FRAME_LENGTH + 1,
      ' ',
    );
    fromRoom(oversize);
    expect(parse.mock.calls.some(([text]) => text === oversize)).toBe(false);
    const honest = await oneTimeInitiator(link);
    fromRoom(oneTimeFrameText('init', await honest.writeMessage()));
    const response = await flushUntil(() => burrowSent('response')[0]);
    await honest.readMessage(fromBase64Url(response.ct as string));
  });

  it('stops reading a room that forwards more than a handshake, before queued work runs', async () => {
    makeRuntime();
    await openLink();
    const deriveBits = vi.spyOn(globalThis.crypto.subtle, 'deriveBits');
    const init = oneTimeFrameText('init', FORGED_CT);
    for (let i = 0; i < MAX_ONE_TIME_FORWARDED; i += 1) fromRoom(init);
    expect(runtime.state.status).toBe('waiting');
    fromRoom(init);
    expect(oneTimeEndReason(runtime)).toBe('burrow-error');
    await settle();
    expect(deriveBits).not.toHaveBeenCalled();
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
  });
});

describe('OneTimeRuntime: the confirmation', () => {
  it('surfaces the request with a label from the closed set', async () => {
    makeRuntime();
    const { link, approval } = await confirming('iPad');
    expect(approval.label).toBe('iPad');
    expect(runtime.state).toEqual({ status: 'confirming', label: 'iPad', expiresAt: link.expiry * 1000 });
  });

  it('never shows text the phone chose: any other label reads as Phone browser, to the end', async () => {
    // The phone picks the digits as well as the label, and the modal draws the
    // label right above their input.
    makeRuntime();
    const { link, phone, approval } = await confirming('iPhone · code 58');
    expect(approval.label).toBe(ONE_TIME_UNKNOWN_DEVICE_LABEL);
    expect(runtime.state).toEqual({
      status: 'confirming',
      label: ONE_TIME_UNKNOWN_DEVICE_LABEL,
      expiresAt: link.expiry * 1000,
    });
    approval.approve(CODE);
    expect(await phone.next()).toEqual({ ok: true, burrowLabel: BURROW_LABEL });
    expect(runtime.state).toEqual({ status: 'connecting', label: ONE_TIME_UNKNOWN_DEVICE_LABEL });
  });

  it('ends burrow-error on a first control that is not a request', async () => {
    makeRuntime();
    const link = await openLink();
    const phone = await joinPhone(link);
    phone.sendControl({ hello: 'there' });
    expect(await phone.next()).toEqual({ ok: false, code: 'burrow-error' });
    expect(oneTimeEndReason(runtime)).toBe('burrow-error');
    expect(approvals).toHaveLength(0);
  });

  it('gives the confirmation exactly one attempt', async () => {
    makeRuntime();
    const { phone, approval } = await confirming();
    approval.approve('07');
    expect(await phone.next()).toEqual({ ok: false, code: 'confirmation-mismatch' });
    expect(oneTimeEndReason(runtime)).toBe('confirmation-mismatch');
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
    expect(oneTimeEndReason(runtime)).toBe('user-denied');
    expect(dismissals).toBe(1);
  });

  // A laptop waking from sleep reads its clock before its overdue deadline
  // runs, so each step checks the expiry itself.
  it('surfaces no request that arrives after the link expired, before its deadline fires', async () => {
    makeRuntime();
    const link = await openLink();
    const phone = await joinPhone(link);
    clock.jump(link.expiry * 1000 + 1 - clock.now());
    phone.sendControl({ code: CODE, label: PHONE_LABEL });
    expect(await phone.next()).toEqual({ ok: false, code: 'link-expired' });
    expect(oneTimeEndReason(runtime)).toBe('expired');
    expect(approvals).toHaveLength(0);
  });

  it('refuses a confirmation made after the link expired, before its deadline fires', async () => {
    makeRuntime();
    const { link, phone, approval } = await confirming();
    clock.jump(link.expiry * 1000 + 1 - clock.now());
    approval.approve(CODE);
    expect(await phone.next()).toEqual({ ok: false, code: 'link-expired' });
    expect(oneTimeEndReason(runtime)).toBe('expired');
    expect(apis).toHaveLength(0);
  });

  it('tells a phone still holding the link at its expiry, dismissing the modal, on its own clock', async () => {
    // A room that would stay open longer: the Burrow's own deadline is what fires.
    makeRuntime({ rendezvous: { expiresAt: (now) => now + ONE_TIME_LINK_TTL_MS + 60_000 } });
    const { link, phone, approval } = await confirming();
    clock.advance(link.expiry * 1000 - clock.now());
    expect(runtime.state.status).toBe('confirming');
    clock.advance(1);
    expect(await phone.next()).toEqual({ ok: false, code: 'link-expired' });
    expect(oneTimeEndReason(runtime)).toBe('expired');
    expect(dismissals).toBe(1);
    // The modal is gone, and an answer that raced its dismissal does nothing.
    approval.approve(CODE);
    await settle();
    expect(burrowSent('transport')).toHaveLength(1);
    expect(apis).toHaveLength(0);
  });

  it('tells a phone that claimed the link but sent no request yet, at its expiry', async () => {
    makeRuntime({ rendezvous: { expiresAt: (now) => now + ONE_TIME_LINK_TTL_MS + 60_000 } });
    const link = await openLink();
    const phone = await joinPhone(link);
    clock.advance(link.expiry * 1000 + 1 - clock.now());
    expect(await phone.next()).toEqual({ ok: false, code: 'link-expired' });
    expect(oneTimeEndReason(runtime)).toBe('expired');
    expect(approvals).toHaveLength(0);
  });
});

describe('OneTimeRuntime: the session', () => {
  it('serves protocol-v1 only once both directions are direct', async () => {
    makeRuntime();
    const { link, phone } = await connecting();
    expect(runtime.state).toEqual({ status: 'connecting', label: PHONE_LABEL });
    expect(dismissals).toBe(1);
    // `hello` answers with the room id: there is no enrollment to name.
    expect(apis.map((api) => api.burrowId)).toEqual([link.roomId]);

    const { peer, inbound } = await negotiateOneTimeDirect(phone, network, clock.setTimer);
    expect(runtime.state.status).toBe('connecting');
    phone.sendControl({ v: 1, t: 'direct-switch' });
    await settleUntil(() => runtime.state.status === 'connected');
    expect(runtime.state).toEqual({ status: 'connected', label: PHONE_LABEL, since: clock.now() });
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
    expect(oneTimeEndReason(runtime)).toBe('burrow-error');
    expect(apis[0]!.handled).toEqual([]);
    expect(apis[0]!.disposed).toBe(true);
  });

  it('declines, tells the phone, then ends direct-failed where it builds no peer', async () => {
    makeRuntime({ createDirectPeer: null });
    const { phone } = await connecting();
    const { reply } = await offerOneTimeDirect(phone, network, clock.setTimer);
    expect(reply).toEqual({ v: 1, t: 'direct-decline' });
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('direct-failed');
    expect(phone.socket.closeCode).toBe(4013);
  });

  it('ends direct-failed when no switch lands by the direct deadline', async () => {
    makeRuntime();
    await connecting();
    clock.advance(DIRECT_ONLY_DEADLINE_MS - 1);
    expect(runtime.state.status).toBe('connecting');
    clock.advance(1);
    expect(oneTimeEndReason(runtime)).toBe('direct-failed');
    expect(apis[0]!.disposed).toBe(true);
  });

  it('reads the phone’s switch before the room’s report that the phone left', async () => {
    makeRuntime();
    const { phone } = await connecting();
    const { peer, inbound } = await negotiateOneTimeDirect(phone, network, clock.setTimer);
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

  describe('held to a path policy', () => {
    it('connects over a pair the policy allows', async () => {
      makeRuntime({ pathPolicy: lanOnlyPolicy() });
      await connected();
      expect(runtime.state.status).toBe('connected');
    });

    it('ends network-not-allowed on a pair it refuses, before anything is served', async () => {
      makeRuntime({ pathPolicy: lanOnlyPolicy(), network: { selectedPair: OFF_LAN } });
      const { phone } = await connecting();
      await offerOneTimeDirect(phone, network, clock.setTimer);
      await settleUntil(() => runtime.state.status === 'ended');
      expect(oneTimeEndReason(runtime)).toBe('network-not-allowed');
      expect(answerers[0]!.closed).toBe(true);
      expect(apis[0]!.handled).toEqual([]);
      expect(apis[0]!.disposed).toBe(true);
    });

    it('ends network-not-allowed, not phone-left, when ICE moves a connected session off it', async () => {
      makeRuntime({ pathPolicy: lanOnlyPolicy() });
      await connected();
      answerers[0]!.setConnectionState('connected');
      answerers[0]!.reselect(OFF_LAN);
      await settleUntil(() => runtime.state.status === 'ended');
      expect(oneTimeEndReason(runtime)).toBe('network-not-allowed');
      expect(answerers[0]!.closed).toBe(true);
    });

    it('ends network-not-allowed when ICE moves a connected session off it with no event', async () => {
      makeRuntime({ pathPolicy: lanOnlyPolicy() });
      await connected();
      answerers[0]!.setConnectionState('connected');
      answerers[0]!.selectedPair = OFF_LAN;
      clock.advance(DIRECT_PATH_RECHECK_MS);
      await settleUntil(() => runtime.state.status === 'ended');
      expect(oneTimeEndReason(runtime)).toBe('network-not-allowed');
    });

    it('ends network-not-allowed when no candidate of its own is on an allowed network', async () => {
      makeRuntime({ pathPolicy: lanOnlyPolicy({ describe: () => null }) });
      const { phone } = await connecting();
      phone.sendControl({ v: 1, t: 'direct-offer', sdp: (await network.createOfferer().createOffer()).sdp! });
      await settleUntil(() => runtime.state.status === 'ended');
      expect(oneTimeEndReason(runtime)).toBe('network-not-allowed');
    });
  });

  it('ends phone-left when the channel is lost after the switch', async () => {
    makeRuntime();
    await connected();
    network.dropChannels();
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('phone-left');
    expect(apis[0]!.disposed).toBe(true);
    expect(answerers[0]!.closed).toBe(true);
  });

  it('reaps an idle session, and a keepalive on the channel defers it', async () => {
    makeRuntime();
    const { phone, peer, inbound } = await connected();
    clock.advance(ESTABLISHED_E2E_IDLE_TIMEOUT_MS - 1_000);
    peer.send(phone.session.sendKeepalive());
    await settle();
    clock.advance(1_000);
    expect(runtime.state.status).toBe('connected');
    clock.advance(ESTABLISHED_E2E_IDLE_TIMEOUT_MS);
    expect(oneTimeEndReason(runtime)).toBe('idle');
    expect(answerers[0]!.closed).toBe(true);
    expect(apis[0]!.disposed).toBe(true);
    // Told, in case it was only quiet.
    await settleUntil(() => inbound.length > 0);
    expect(openReceipt(phone.session, inbound.at(-1)!)).toEqual({ v: 1, t: 'session-end' });
  });

  it('hands its session the phone’s label, and an end that is this runtime’s End', async () => {
    makeRuntime();
    const { phone, inbound } = await connected();
    expect(apis[0]!.label).toBe(PHONE_LABEL);

    apis[0]!.end();
    expect(oneTimeEndReason(runtime)).toBe('user-ended');
    expect(apis[0]!.disposed).toBe(true);
    // The goodbye rides the channel, the one path left after the switch.
    await settleUntil(() => inbound.length > 0);
    expect(openReceipt(phone.session, inbound.at(-1)!)).toEqual({ v: 1, t: 'session-end' });

    // Once over, it ends nothing: a later runtime's session is not its own.
    const reasons = states.length;
    apis[0]!.end();
    expect(states).toHaveLength(reasons);
  });

  it('tells a phone still connecting that the laptop ended it, over the rendezvous', async () => {
    makeRuntime();
    const { phone } = await connecting();
    runtime.end();
    expect(await phone.next()).toEqual({ v: 1, t: 'session-end' });
    expect(oneTimeEndReason(runtime)).toBe('user-ended');
  });

  it('says nothing when the phone’s own leaving ended it', async () => {
    makeRuntime();
    const { phone, inbound } = await connected();
    network.dropChannels();
    await settleUntil(() => runtime.state.status === 'ended');
    await settle();
    expect(inbound.map((frame) => openReceipt(phone.session, frame))).not.toContainEqual({
      v: 1,
      t: 'session-end',
    });
  });
});

describe('OneTimeRuntime: the rendezvous closing before the switch', () => {
  it('ends phone-left when the phone leaves the room, dismissing its request', async () => {
    makeRuntime();
    const { phone } = await confirming();
    phone.socket.close();
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('phone-left');
    expect(dismissals).toBe(1);
  });

  it('ends expired when the room’s deadline passes, joined or not', async () => {
    makeRuntime();
    await openLink();
    rendezvous.expire(rendezvous.room().roomId);
    await settleUntil(() => runtime.state.status === 'ended');
    expect(rendezvous.room().burrow.closeCode).toBe(4010);
    expect(oneTimeEndReason(runtime)).toBe('expired');
    runtime.end();

    makeRuntime();
    await joinPhone(await openLink());
    rendezvous.expire(rendezvous.room().roomId);
    await settleUntil(() => runtime.state.status === 'ended');
    expect(rendezvous.room().burrow.closeCode).toBe(4014);
    expect(oneTimeEndReason(runtime)).toBe('expired');
  });

  it('ends burrow-error when the room closes it for a violation', async () => {
    makeRuntime();
    const phone = await joinPhone(await openLink());
    phone.socket.send('x'.repeat(MAX_ONE_TIME_FRAME_LENGTH + 1));
    await settleUntil(() => runtime.state.status === 'ended');
    expect(rendezvous.room().burrow.closeCode).toBe(4015);
    expect(oneTimeEndReason(runtime)).toBe('burrow-error');
  });

  it('ends rendezvous-lost on a close the room did not name', async () => {
    makeRuntime();
    await openLink();
    rendezvous.room().burrow.closeWith(1006);
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('rendezvous-lost');
  });
});

describe('OneTimeRuntime: end()', () => {
  it('closes the rendezvous and leaves no timer armed', async () => {
    makeRuntime();
    await openLink();
    runtime.end();
    expect(oneTimeEndReason(runtime)).toBe('user-ended');
    expect(rendezvous.room().burrow.closeCode).toBe(1000);
    expect(rendezvous.room().deleted).toBe(true);
    expect(clock.armed).toBe(0);
    runtime.end('idle');
    expect(oneTimeEndReason(runtime)).toBe('user-ended');
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
    expect(oneTimeEndReason(runtime)).toBe('user-ended');
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

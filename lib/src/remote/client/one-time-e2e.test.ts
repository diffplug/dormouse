/**
 * A one-time connection end to end: the **real** `OneTimeRuntime` and the
 * **real** `OneTimeClient` through the in-memory room (`../test-rendezvous.ts`),
 * over the in-memory direct path (`../direct/test-fake-peer.ts`), the laptop
 * serving the real `RemoteApiSession` over a one-pane provider
 * (`docs/specs/one-time.md`; `docs/specs/remote-security-model.md` ->
 * "One-time connection").
 *
 * **No ceremony step is stubbed**: the link is parsed back from the URL the
 * runtime minted, the handshake is the shipped suite, and the two digits the
 * laptop types are the ones the phone showed. Every deadline runs on one
 * injected test clock, shared by both ends, the room, and the peers.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ONE_TIME_DIRECT_DEADLINE_MS,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type DirectoryEntry,
  type OneTimeLink,
} from 'remote-lib-common';

import {
  ONE_TIME_DENIAL_MESSAGES,
  ONE_TIME_DIRECT_FAILED_MESSAGE,
  ONE_TIME_ENDED_MESSAGE,
  ONE_TIME_LINK_EXPIRED_MESSAGE,
  ONE_TIME_LINK_USED_MESSAGE,
  OneTimeClient,
  type OneTimeResult,
} from './one-time-client';
import type { PageVisibility } from './session-core';
import {
  OneTimeRuntime,
  type OneTimeApprovalRequest,
  type OneTimeState,
} from '../burrow/one-time-runtime';
import { RemoteApiSession } from '../burrow/remote-api';
import type {
  BurrowSurfaceProvider,
  PtySink,
  SurfaceHandle,
} from '../burrow/burrow-surface-provider';
import type { DirectPeerFactory } from '../direct/direct-peer';
import { FakeDirectNetwork, type FakeDirectNetworkOptions } from '../direct/test-fake-peer';
import { settleUntil } from '../test-e2e-client';
import {
  createTestRendezvous,
  oneTimeEndReason,
  openOneTimeLink,
  type TestRendezvous,
} from '../test-rendezvous';
import { createTestClock, type TestClock } from '../test-timers';

const ORIGIN = 'https://hosted.example';
const START = 1_700_000_000_000;
const BURROW_LABEL = 'Ned’s laptop';
const PHONE_LABEL = 'iPhone Safari';
const SURFACE_ID = 'surface-1';
const PTY_ID = 'pty-1';

const ENTRY: DirectoryEntry = {
  paneRef: SURFACE_ID,
  surfaceId: SURFACE_ID,
  type: 'terminal',
  title: 'zsh',
  focused: true,
  alive: true,
  ringing: false,
  hasTODO: false,
};

const VISIBLE: PageVisibility = { isVisible: () => true, subscribe: () => () => {} };

/** One pane at 80×24, whose PTY echoes whatever is written to it. */
class OnePaneProvider implements BurrowSurfaceProvider {
  readonly writes: Array<[string, string]> = [];
  readonly #sinks = new Set<PtySink>();
  readonly #handle: SurfaceHandle = {
    ptyId: PTY_ID,
    cols: 80,
    rows: 24,
    resize: async (cols, rows) => ({ cols, rows }),
  };

  collectDirectory = async (): Promise<DirectoryEntry[]> => [ENTRY];
  watchDirectory = (): (() => void) => () => {};
  resolveSurface = async (surfaceId: string): Promise<SurfaceHandle | null> =>
    surfaceId === SURFACE_ID ? this.#handle : null;
  writePty = (ptyId: string, data: string): void => {
    this.writes.push([ptyId, data]);
    for (const sink of this.#sinks) sink.onData({ data });
  };
  resizePty = (): void => {};
  streamPty = (_ptyId: string, sink: PtySink) => {
    this.#sinks.add(sink);
    return { stop: () => void this.#sinks.delete(sink), ready: Promise.resolve() };
  };
}

let clock: TestClock;
let rendezvous: TestRendezvous;
let network: FakeDirectNetwork;
let provider: OnePaneProvider;
let runtime: OneTimeRuntime;
let states: OneTimeState[];
let approvals: OneTimeApprovalRequest[];
let phones: OneTimeClient[];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clock = createTestClock(START);
  rendezvous = createTestRendezvous({ now: clock.now, setTimer: clock.setTimer });
  network = new FakeDirectNetwork();
  provider = new OnePaneProvider();
  states = [];
  approvals = [];
  phones = [];
});

afterEach(() => {
  runtime?.end();
  for (const phone of phones) phone.close();
  vi.restoreAllMocks();
});

function makeRuntime(
  options: { network?: FakeDirectNetworkOptions; createDirectPeer?: DirectPeerFactory | null } = {},
): OneTimeRuntime {
  if (options.network) network = new FakeDirectNetwork(options.network);
  runtime = new OneTimeRuntime({
    origin: ORIGIN,
    createWebSocket: (url) => rendezvous.createBurrowSocket(url),
    createSession: ({ burrowId, send }) => new RemoteApiSession({ burrowId, send, provider }),
    createDirectPeer:
      options.createDirectPeer === undefined ? () => network.createAnswerer() : options.createDirectPeer,
    burrowLabel: BURROW_LABEL,
    requestApproval: (request) => void approvals.push(request),
    dismissApproval: () => {},
    onChange: (state) => void states.push(state),
    now: clock.now,
    setTimer: clock.setTimer,
  });
  return runtime;
}

/** A phone as the page builds one, on the room's origin. */
function makePhone(): OneTimeClient {
  const phone = new OneTimeClient({
    wsOrigin: 'wss://hosted.example',
    createWebSocket: (url) => rendezvous.createClientSocket(url),
    now: clock.now,
    setTimer: clock.setTimer,
    visibility: VISIBLE,
    createDirectPeer: () => network.createOfferer(),
  });
  phones.push(phone);
  return phone;
}

/** Open the runtime and read its link back the way the phone page does. */
const openLink = (): Promise<OneTimeLink> => openOneTimeLink(runtime, ORIGIN, clock.now);

/** Tap Connect, and wait for the laptop's approval modal with the digits the phone shows. */
async function tapConnect(phone: OneTimeClient, link: OneTimeLink): Promise<{
  result: Promise<OneTimeResult>;
  approval: OneTimeApprovalRequest;
  shown: string;
}> {
  const before = approvals.length;
  let shown: string | null = null;
  const result = phone.connectOnce(link, PHONE_LABEL, (code) => {
    shown = code;
  });
  await settleUntil(() => approvals.length > before);
  const approval = approvals[before];
  if (!approval || shown === null) throw new Error('the laptop surfaced no request');
  return { result, approval, shown };
}

describe('one-time connection, end to end', () => {
  it('connects on the shown digits, runs protocol-v1 on the channel alone, ends with the laptop', async () => {
    makeRuntime({ network: { opening: 'manual' } });
    const link = await openLink();
    const phone = makePhone();
    const ended: string[] = [];
    phone.setOnEnded((message) => void ended.push(message));

    const { result, approval, shown } = await tapConnect(phone, link);
    expect(approval.label).toBe(PHONE_LABEL);
    approval.approve(shown);
    await settleUntil(() => runtime.state.status === 'connecting' && network.offererChannel !== null);
    // Confirmed but not yet direct: the phone refuses protocol-v1, so the laptop
    // has nothing to end the session over.
    await expect(phone.hello()).rejects.toThrow(/not direct/);
    expect(runtime.state.status).toBe('connecting');

    network.openChannels();
    expect(await result).toEqual({ ok: true, burrowLabel: BURROW_LABEL });
    await settleUntil(() => runtime.state.status === 'connected');
    expect(runtime.state).toMatchObject({ status: 'connected', label: PHONE_LABEL });
    // Both ends left the room at the switch: the phone closed its own normally.
    const room = rendezvous.room();
    expect(room.client!.closeCode).toBe(1000);
    expect(room.deleted).toBe(true);

    expect(await phone.hello()).toEqual({
      protocolVersion: 1,
      burrowId: link.roomId,
      grants: { input: true, layout: false },
    });
    const snapshots: DirectoryEntry[][] = [];
    await phone.watchDirectory((entries) => void snapshots.push(entries));
    await settleUntil(() => snapshots.length > 0);
    expect(snapshots[0]).toEqual([ENTRY]);
    const echoed: string[] = [];
    const attached = await phone.attach(SURFACE_ID, 80, 24, {
      onData: (event) => void echoed.push(utf8Decode(fromBase64Url(event.bytes))),
    });
    expect(attached.result).toEqual({ cols: 80, rows: 24 });
    await phone.write(SURFACE_ID, toBase64Url(utf8Encode('ls\r')));
    expect(provider.writes).toEqual([[PTY_ID, 'ls\r']]);
    await settleUntil(() => echoed.includes('ls\r'));
    expect(echoed).toContain('ls\r');
    // All of it rode the channel; the room carried the handshake alone.
    expect(network.offererChannel!.sent.length).toBeGreaterThan(0);

    runtime.end();
    await settleUntil(() => ended.length > 0);
    expect(ended).toEqual([ONE_TIME_ENDED_MESSAGE]);
    await expect(phone.hello()).rejects.toThrow();
    expect(states.map((state) => state.status)).toEqual([
      'opening',
      'waiting',
      'confirming',
      'connecting',
      'connected',
      'ended',
    ]);
  });

  it('ends at both ends when the phone leaves the Wi-Fi after the switch', async () => {
    makeRuntime();
    const link = await openLink();
    const phone = makePhone();
    const ended: string[] = [];
    phone.setOnEnded((message) => void ended.push(message));
    const { result, approval, shown } = await tapConnect(phone, link);
    approval.approve(shown);
    expect((await result).ok).toBe(true);
    await settleUntil(() => runtime.state.status === 'connected');

    network.dropChannels();
    await settleUntil(() => ended.length > 0 && runtime.state.status === 'ended');
    expect(ended).toEqual([ONE_TIME_ENDED_MESSAGE]);
    expect(oneTimeEndReason(runtime)).toBe('phone-left');
  });

  it('fails an attempt whose session is lost at the switch, rather than resolving it', async () => {
    makeRuntime({ network: { opening: 'manual' } });
    const phone = makePhone();
    const ended: string[] = [];
    phone.setOnEnded((message) => void ended.push(message));
    const { result, approval, shown } = await tapConnect(phone, await openLink());
    approval.approve(shown);
    await settleUntil(() => network.offererChannel !== null && network.answererChannel !== null);
    // Both ends switch inside the open, and the channel goes in the same turn.
    network.openChannels();
    network.dropChannels();
    expect(await result).toEqual({ ok: false, message: ONE_TIME_ENDED_MESSAGE });
    expect(ended).toEqual([]);
    await expect(phone.hello()).rejects.toThrow();
  });

  it('tells the laptop when the phone closes, and reports nothing to the phone', async () => {
    makeRuntime();
    const link = await openLink();
    const phone = makePhone();
    const ended: string[] = [];
    phone.setOnEnded((message) => void ended.push(message));
    const { result, approval, shown } = await tapConnect(phone, link);
    approval.approve(shown);
    expect((await result).ok).toBe(true);
    await settleUntil(() => runtime.state.status === 'connected');

    phone.close();
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('phone-left');
    expect(ended).toEqual([]);
  });

  it('refuses digits the phone was not showing, and a denial, each in its own words', async () => {
    makeRuntime();
    const mismatched = await tapConnect(makePhone(), await openLink());
    mismatched.approval.approve(mismatched.shown === '00' ? '01' : '00');
    expect(await mismatched.result).toEqual({
      ok: false,
      message: ONE_TIME_DENIAL_MESSAGES['confirmation-mismatch'],
    });
    expect(oneTimeEndReason(runtime)).toBe('confirmation-mismatch');

    makeRuntime();
    const denied = await tapConnect(makePhone(), await openLink());
    denied.approval.deny();
    expect(await denied.result).toEqual({ ok: false, message: ONE_TIME_DENIAL_MESSAGES['user-denied'] });
    expect(oneTimeEndReason(runtime)).toBe('user-denied');
  });

  it('tells a second phone the link was already used, before and after the first connects', async () => {
    makeRuntime();
    const link = await openLink();
    const first = await tapConnect(makePhone(), link);
    // The first phone holds the room: the second is refused at the join.
    expect(await makePhone().connectOnce(link, 'Pixel Chrome', () => {})).toEqual({
      ok: false,
      message: ONE_TIME_LINK_USED_MESSAGE,
    });
    expect(runtime.state.status).toBe('confirming');

    first.approval.approve(first.shown);
    expect((await first.result).ok).toBe(true);
    await settleUntil(() => runtime.state.status === 'connected');
    // The room is gone once both ends switched.
    expect(await makePhone().connectOnce(link, 'Pixel Chrome', () => {})).toEqual({
      ok: false,
      message: ONE_TIME_LINK_USED_MESSAGE,
    });
    expect(runtime.state.status).toBe('connected');
  });

  it('gives the same-Wi-Fi copy when the laptop builds no peer', async () => {
    makeRuntime({ createDirectPeer: null });
    const { result, approval, shown } = await tapConnect(makePhone(), await openLink());
    approval.approve(shown);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('direct-failed');
  });

  it('gives the same-Wi-Fi copy when no channel opens by the direct deadline', async () => {
    makeRuntime({ network: { opening: 'never' } });
    const { result, approval, shown } = await tapConnect(makePhone(), await openLink());
    approval.approve(shown);
    await settleUntil(() => network.offererChannel !== null);
    clock.advance(ONE_TIME_DIRECT_DEADLINE_MS);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('direct-failed');
  });

  it('says the link expired, whether the phone taps late or the laptop confirms late', async () => {
    makeRuntime();
    const late = await openLink();
    clock.advance(late.expiry * 1000 + 1 - clock.now());
    expect(await makePhone().connectOnce(late, PHONE_LABEL, () => {})).toEqual({
      ok: false,
      message: ONE_TIME_LINK_EXPIRED_MESSAGE,
    });
    expect(rendezvous.room().client).toBeNull();

    makeRuntime();
    const link = await openLink();
    const { result, approval, shown } = await tapConnect(makePhone(), link);
    clock.advance(link.expiry * 1000 + 1 - clock.now());
    approval.approve(shown);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_LINK_EXPIRED_MESSAGE });
    expect(oneTimeEndReason(runtime)).toBe('expired');
  });
});

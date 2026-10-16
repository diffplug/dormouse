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
  DIRECT_ONLY_DEADLINE_MS,
  fromBase64Url,
  parseOneTimeLinkUrl,
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
import type { DirectPathPolicy, DirectPeerFactory } from '../direct/direct-peer';
import type { PathRefusal } from '../direct/path-refusal';
import {
  FakeDirectNetwork,
  OFF_LAN_PAIR,
  lanOnlyPolicy,
  type FakeDirectNetworkOptions,
} from '../direct/test-fake-peer';
import { settleUntil } from '../test-e2e-client';
import {
  createTestRendezvous,
  oneTimeEndReason,
  openOneTimeLink,
  type TestRendezvous,
} from '../test-rendezvous';
import { createTestClock, type TestClock } from '../test-timers';
import { createAskSurfaceProvider } from '../../host/remote/ask-surface-provider';
import { createEphemeralBurrowStateStore } from '../../host/remote/burrow-state-store';
import { BurrowService } from '../../host/remote/service';
import type { OneTimeEvent, PairingQueueEvent } from '../../host/remote/service-protocol';
import { FakePtyAdapter, setPlatform, type PlatformAdapter } from '../../lib/platform';
import { clearSizeHold, getSizeHolds } from '../../lib/size-hold-store';
import { registry, type TerminalEntry } from '../../lib/terminal-store';
import { installPeerSurfaceResponder } from '../burrow/peer-surfaces';
import { takeBackSize } from '../burrow/take-back';

const ORIGIN = 'https://hosted.example';
const START = 1_700_000_000_000;
const BURROW_LABEL = 'Ned’s laptop';
const PHONE_LABEL = 'iPhone';
const SURFACE_ID = 'surface:1';
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
    release: () => {},
  };

  collectDirectory = async (): Promise<DirectoryEntry[]> => [ENTRY];
  watchDirectory = (): (() => void) => () => {};
  resolveSurface = async (surfaceId: string): Promise<SurfaceHandle | null> =>
    surfaceId === SURFACE_ID ? this.#handle : null;
  releaseSurface = (): void => {};
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
let refusals: PathRefusal[];

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  clock = createTestClock(START);
  rendezvous = createTestRendezvous({ now: clock.now, setTimer: clock.setTimer });
  network = new FakeDirectNetwork();
  provider = new OnePaneProvider();
  states = [];
  approvals = [];
  phones = [];
  refusals = [];
});

afterEach(() => {
  runtime?.end();
  for (const phone of phones) phone.close();
  vi.restoreAllMocks();
});

function makeRuntime(
  options: {
    network?: FakeDirectNetworkOptions;
    createDirectPeer?: DirectPeerFactory | null;
    pathPolicy?: DirectPathPolicy;
  } = {},
): OneTimeRuntime {
  if (options.network) network = new FakeDirectNetwork(options.network);
  runtime = new OneTimeRuntime({
    origin: ORIGIN,
    createWebSocket: (url) => rendezvous.createBurrowSocket(url),
    createSession: ({ burrowId, send, label }) =>
      new RemoteApiSession({ burrowId, send, provider, holder: { id: 'holder-1', label } }),
    directPeering: {
      createPeer: options.createDirectPeer === undefined ? () => network.createAnswerer() : options.createDirectPeer,
      ...(options.pathPolicy ? { pathPolicy: options.pathPolicy } : {}),
    },
    onPathRefused: (refusal) => void refusals.push(refusal),
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
    expect(await makePhone().connectOnce(link, 'Android phone', () => {})).toEqual({
      ok: false,
      message: ONE_TIME_LINK_USED_MESSAGE,
    });
    expect(runtime.state.status).toBe('confirming');

    first.approval.approve(first.shown);
    expect((await first.result).ok).toBe(true);
    await settleUntil(() => runtime.state.status === 'connected');
    // The room is gone once both ends switched.
    expect(await makePhone().connectOnce(link, 'Android phone', () => {})).toEqual({
      ok: false,
      message: ONE_TIME_LINK_USED_MESSAGE,
    });
    expect(runtime.state.status).toBe('connected');
  });

  it('tells a phone still connecting that the laptop ended it, rather than blaming the Wi-Fi', async () => {
    makeRuntime({ network: { opening: 'manual' } });
    const { result, approval, shown } = await tapConnect(makePhone(), await openLink());
    approval.approve(shown);
    await settleUntil(() => runtime.state.status === 'connecting' && network.offererChannel !== null);

    // No channel yet: the goodbye rides the room, and only it tells the phone
    // this was the laptop's End rather than no direct path.
    runtime.end();
    expect(await result).toEqual({ ok: false, message: ONE_TIME_ENDED_MESSAGE });
  });

  it('tells a phone off the allowed networks where the laptop saw it, as the laptop records it', async () => {
    makeRuntime({ network: { selectedPair: OFF_LAN_PAIR }, pathPolicy: lanOnlyPolicy() });
    const { result, approval, shown } = await tapConnect(makePhone(), await openLink());
    approval.approve(shown);
    expect(await result).toEqual({
      ok: false,
      message:
        'This computer only accepts phones on its allowed networks. Yours connected from 10.0.0.3 — ' +
        'join the same Wi-Fi or VPN as the computer and try again.',
    });
    await settleUntil(() => runtime.state.status === 'ended');
    const refusal = { at: expect.any(Number), kind: 'path-refused', end: 'remote', address: '10.0.0.3', addressSource: 'observed' };
    expect(runtime.state).toEqual({ status: 'ended', reason: 'network-not-allowed', refusal });
    expect(refusals).toEqual([refusal]);
  });

  it('gives the direct-failed copy, naming no network, when the laptop’s own end was off the allowed networks', async () => {
    makeRuntime({ network: { selectedPair: { local: '10.0.0.2', remote: '192.168.1.3' } }, pathPolicy: lanOnlyPolicy() });
    const { result, approval, shown } = await tapConnect(makePhone(), await openLink());
    approval.approve(shown);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
    await settleUntil(() => runtime.state.status === 'ended');
    const refusal = { at: expect.any(Number), kind: 'path-refused', end: 'local', localAddress: '10.0.0.2' };
    expect(runtime.state).toEqual({ status: 'ended', reason: 'network-not-allowed', refusal });
  });

  it('gives the direct-failed copy when the laptop builds no peer', async () => {
    makeRuntime({ createDirectPeer: null });
    const { result, approval, shown } = await tapConnect(makePhone(), await openLink());
    approval.approve(shown);
    expect(await result).toEqual({ ok: false, message: ONE_TIME_DIRECT_FAILED_MESSAGE });
    await settleUntil(() => runtime.state.status === 'ended');
    expect(oneTimeEndReason(runtime)).toBe('direct-failed');
  });

  it('gives the direct-failed copy when no channel opens by the direct deadline', async () => {
    makeRuntime({ network: { opening: 'never' } });
    const { result, approval, shown } = await tapConnect(makePhone(), await openLink());
    approval.approve(shown);
    await settleUntil(() => network.offererChannel !== null);
    clock.advance(DIRECT_ONLY_DEADLINE_MS);
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

/**
 * Size authority across a one-time connection, with the laptop's real halves:
 * the `BurrowService` (its approval queue, its Take back), the ask-backed
 * provider, and this webview's surface responder over a registry pane — the
 * same chain the sidecar runs, with the bridge in memory
 * (`docs/specs/remote-api.md` → "Size authority").
 */
describe('size authority across a one-time connection, end to end', () => {
  let service: BurrowService;
  let toUi: Array<{ event: string; data: unknown }>;
  let responders: Map<string, (params: unknown) => unknown[]>;
  let terminal: { cols: number; rows: number; resize: ReturnType<typeof vi.fn> };
  let commandSeq: number;
  /** The webview's `burrow:event` listeners, by event name. */
  let listeners: Map<string, Set<(data: unknown) => void>>;

  /** What the service sends this webview, as the sidecar bridge carries it. */
  function toWebview(event: string, data: unknown): void {
    toUi.push({ event, data });
    if (event !== 'burrow:event') return;
    for (const listener of [...(listeners.get((data as { name: string }).name) ?? [])]) listener(data);
  }

  /** One `burrow:command` and the `burrow:result` it produced. */
  async function command(cmd: string, params?: unknown): Promise<unknown> {
    const burrowRequestId = `c-${++commandSeq}`;
    await service.handleCommand({ burrowRequestId, cmd, params });
    const answer = toUi.find(
      (line) =>
        line.event === 'burrow:result' &&
        (line.data as { burrowRequestId?: string }).burrowRequestId === burrowRequestId,
    )?.data as { result?: unknown; error?: string } | undefined;
    if (!answer || answer.error) throw new Error(answer?.error ?? `no result for ${cmd}`);
    return answer.result;
  }

  function oneTimeState(): OneTimeState | undefined {
    return toUi
      .filter((line) => line.event === 'burrow:event' && (line.data as OneTimeEvent).name === 'one-time')
      .map((line) => (line.data as OneTimeEvent).state)
      .at(-1);
  }

  beforeEach(async () => {
    toUi = [];
    responders = new Map();
    listeners = new Map();
    commandSeq = 0;
    terminal = {
      cols: 80,
      rows: 24,
      resize: vi.fn((cols: number, rows: number) => {
        terminal.cols = cols;
        terminal.rows = rows;
      }),
    };
    registry.set(SURFACE_ID, { terminal } as unknown as TerminalEntry);
    const sinks = new Set<PtySink>();
    const { provider } = createAskSurfaceProvider(
      async (op, params) => responders.get(op)?.(params) ?? [],
      {
        writePty: (_ptyId, data) => {
          for (const sink of sinks) sink.onData({ data });
        },
        resizePty: () => {},
        streamPty: (_ptyId, sink) => {
          sinks.add(sink);
          return { stop: () => void sinks.delete(sink), ready: Promise.resolve() };
        },
      },
    );
    // Local networks: a new install is at Nothing, which opens no link
    // (`docs/specs/remote-network.md` → "Policy").
    const store = createEphemeralBurrowStateStore(() => {});
    await store.saveNetworkPolicy({ level: 'local', allowed: ['192.168.1.0/24'], autoUpdate: false });
    service = new BurrowService({
      store,
      provider,
      kind: 'standalone',
      sendToUi: toWebview,
      // A Hosted build: the only kind with one-time connections.
      relay: { origin: ORIGIN, mode: 'hosted' },
      createWebSocket: (url) => rendezvous.createBurrowSocket(url) as never,
      createDirectPeer: () => network.createAnswerer(),
      now: clock.now,
    });
    // This webview, reaching that service over its link as the sidecar bridge does.
    const webview = {
      ...new FakePtyAdapter(),
      burrow: {
        command: (cmd: string, params?: unknown) => command(cmd, params),
        respond: (op: string, handler: (params: unknown) => unknown[]) => void responders.set(op, handler),
        notify: () => {},
        on: (name: string, listener: (data: unknown) => void) => {
          const named = listeners.get(name) ?? new Set();
          listeners.set(name, named);
          named.add(listener);
          return () => void named.delete(listener);
        },
      },
    };
    setPlatform(webview as unknown as PlatformAdapter);
    installPeerSurfaceResponder();
  });

  afterEach(() => {
    service.dispose();
    clearSizeHold(SURFACE_ID);
    registry.delete(SURFACE_ID);
    setPlatform(new FakePtyAdapter());
  });

  /** Open a link on the service, connect a phone through its approval queue, and attach the pane. */
  async function attachedPhone(): Promise<{ phone: OneTimeClient; ended: string[] }> {
    const waiting = (await command('oneTimeOpen')) as OneTimeState;
    if (waiting.status !== 'waiting') throw new Error(`expected waiting, got ${waiting.status}`);
    const link = await parseOneTimeLinkUrl(waiting.url, ORIGIN, clock.now());
    if (!link) throw new Error('the phone could not read the link');
    const phone = makePhone();
    const ended: string[] = [];
    phone.setOnEnded((message) => void ended.push(message));
    let shown: string | null = null;
    const result = phone.connectOnce(link, PHONE_LABEL, (code) => {
      shown = code;
    });
    await settleUntil(() =>
      toUi.some(
        (line) =>
          line.event === 'burrow:event' &&
          (line.data as PairingQueueEvent).name === 'pairing-queue' &&
          (line.data as PairingQueueEvent).queue.length > 0,
      ),
    );
    const queue = toUi
      .map((line) => line.data as PairingQueueEvent)
      .filter((event) => event.name === 'pairing-queue')
      .at(-1)!.queue;
    await command('approve', { kind: 'one-time', clientId: '', pairingId: queue[0]!.pairingId, code: shown });
    expect((await result).ok).toBe(true);
    await settleUntil(() => oneTimeState()?.status === 'connected');

    const attached = await phone.attach(SURFACE_ID, 51, 14, { onData: () => {} });
    expect(attached.result).toEqual({ cols: 51, rows: 14 });
    return { phone, ended };
  }

  it('holds the laptop pane at the phone’s size, and Take back ends the phone and gives it back', async () => {
    const { ended } = await attachedPhone();
    // The laptop pane is at the phone's grid and held under the phone's name:
    // its own box no longer sizes it, so a local refit leaves the phone's
    // wrapping alone.
    expect(terminal.resize).toHaveBeenLastCalledWith(51, 14);
    expect(getSizeHolds(SURFACE_ID)).toMatchObject([{ label: PHONE_LABEL }]);

    await takeBackSize(SURFACE_ID);
    // The whole one-time connection ended, as its End would.
    expect(oneTimeState()).toEqual({ status: 'ended', reason: 'user-ended' });
    await settleUntil(() => ended.length > 0);
    expect(ended).toEqual([ONE_TIME_ENDED_MESSAGE]);
    // And the pane is its own again, for its next fit.
    expect(getSizeHolds(SURFACE_ID)).toEqual([]);
  });

  it('gives the pane back when the laptop ends the connection', async () => {
    const { ended } = await attachedPhone();
    expect(getSizeHolds(SURFACE_ID)).toHaveLength(1);

    await command('oneTimeEnd');
    await settleUntil(() => getSizeHolds(SURFACE_ID).length === 0);
    expect(getSizeHolds(SURFACE_ID)).toEqual([]);
    await settleUntil(() => ended.length > 0);
    expect(ended).toEqual([ONE_TIME_ENDED_MESSAGE]);
  });

  it('drops the hold of a service that is gone once the one replacing it speaks', async () => {
    await attachedPhone();
    // Held under this service instance, whose own status — every serving flip
    // on the way here — dropped nothing.
    const { serviceId } = service.statusEvent();
    expect(getSizeHolds(SURFACE_ID)).toMatchObject([{ label: PHONE_LABEL, serviceId }]);

    // The service went without a word — its broker window closed, or its
    // sidecar restarted — and another starts in its place.
    const replacement = new BurrowService({
      store: createEphemeralBurrowStateStore(() => {}),
      provider: new OnePaneProvider(),
      kind: 'standalone',
      sendToUi: toWebview,
      // A Hosted build: the only kind with one-time connections.
      relay: { origin: ORIGIN, mode: 'hosted' },
    });
    try {
      await replacement.start();
      expect(getSizeHolds(SURFACE_ID)).toEqual([]);
    } finally {
      replacement.dispose();
    }
  });

  it('gives the pane back when the phone detaches, and when it attaches another', async () => {
    registry.set('surface:2', { terminal: { ...terminal, resize: vi.fn() } } as unknown as TerminalEntry);
    const { phone } = await attachedPhone();
    await phone.attach('surface:2', 51, 14, { onData: () => {} });
    await settleUntil(() => getSizeHolds(SURFACE_ID).length === 0);
    expect(getSizeHolds('surface:2')).toMatchObject([{ label: PHONE_LABEL }]);

    await phone.detach('surface:2');
    await settleUntil(() => getSizeHolds('surface:2').length === 0);
    registry.delete('surface:2');
  });
});

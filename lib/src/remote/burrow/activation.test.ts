/**
 * The webview's end of the Burrow service (`lib/src/host/remote/service.ts`): it
 * forwards console commands, mirrors the pairing queue, and refreshes the push
 * device list. It starts no `BurrowRuntime` of its own and holds no Burrow state
 * — there is no webview-resident mode left to fall back to, so a host with no
 * service behind it gets nothing at all.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BurrowLink } from '../../lib/platform/types';
import {
  makeEventedBurrowLink,
  type EventedBurrowLink,
} from '../../host/remote/test-burrow-link';

/** The dialog's device store, as this module drives it. */
const devices = vi.hoisted(() => ({
  /** Every refresher installed, latest last. */
  refreshers: [] as Array<() => void>,
  /** Every `clearPushDevices()`: the disarm's one call. */
  cleared: 0,
}));
vi.mock('../../lib/push-devices', () => ({
  commitPushDevices: async (load: () => Promise<unknown>) => void (await load()),
  setPushDevicesRefresher: (refresh: () => void) => void devices.refreshers.push(refresh),
  clearPushDevices: () => {
    devices.cleared += 1;
  },
}));

let burrowLink: BurrowLink | undefined;
// A burrow with `burrow` has a Burrow service behind it; without one (the
// website) there is no Burrow anywhere.
vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ burrow: burrowLink }),
}));

beforeEach(() => {
  burrowLink = undefined;
  devices.refreshers.length = 0;
  devices.cleared = 0;
  // The console hook lives on globalThis and outlives `vi.resetModules()`;
  // leaving it set would make the next test call the previous module's closure.
  delete (globalThis as { dormouseBurrow?: unknown }).dormouseBurrow;
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- Bridge mode ---

interface FakeLink extends EventedBurrowLink<BurrowLink['command']> {
  commands: Array<{ cmd: string; params?: unknown }>;
  results: Record<string, unknown>;
}

/** A link recording every command and answering each from `results`. */
function fakeLink(): FakeLink {
  const commands: FakeLink['commands'] = [];
  const results: FakeLink['results'] = {};
  const link = makeEventedBurrowLink(async (cmd, params) => {
    commands.push({ cmd, params });
    return results[cmd];
  });
  return Object.assign(link, { commands, results });
}

/**
 * Install in bridge mode and hand back the module's fresh pairing store.
 * Enrolled unless a test says otherwise: that is the state everything but the
 * gate's own cases is about.
 */
async function installBridge(link: FakeLink) {
  link.results.status ??= { enrolled: true };
  burrowLink = link;
  vi.resetModules();
  const mod = await import('./activation');
  const pairing = await import('./pairing-approval');
  mod.installBurrowConsoleHook();
  // The `status` seed gates the device fetch and the queue seed behind it.
  await settle();
  return { mod, pairing };
}

/** Let the boot round trips land. */
async function settle(): Promise<void> {
  for (let i = 0; i < 4; i++) await Promise.resolve();
}

function consoleHook() {
  return (globalThis as {
    dormouseBurrow?: {
      enroll: (password: string, label: string) => Promise<unknown>;
      beginHostedEnrollment: (label: string) => Promise<unknown>;
      cancelHostedEnrollment: () => Promise<unknown>;
      status: () => unknown;
      reconnect: () => unknown;
      clearEnrollment: () => unknown;
    };
  }).dormouseBurrow!;
}

describe('burrow bridge mode', () => {
  it('does nothing at all with no service behind the burrow', async () => {
    // The website: no `burrow`, so no console hook and no commands. There
    // is no webview-resident Burrow to fall back to.
    burrowLink = undefined;
    vi.resetModules();
    const mod = await import('./activation');
    mod.installBurrowConsoleHook();
    expect((globalThis as { dormouseBurrow?: unknown }).dormouseBurrow).toBeUndefined();
  });

  it('forwards every console method to the service', async () => {
    const link = fakeLink();
    link.results.status = { enrolled: true };
    await installBridge(link);

    await consoleHook().enroll('password', 'Laptop');
    expect(await consoleHook().status()).toEqual({ enrolled: true });
    await consoleHook().reconnect();
    await consoleHook().clearEnrollment();
    await consoleHook().beginHostedEnrollment('Laptop');
    await consoleHook().cancelHostedEnrollment();

    expect(link.commands.map((c) => c.cmd)).toEqual(
      expect.arrayContaining([
        'enroll',
        'status',
        'reconnect',
        'clearEnrollment',
        'beginHostedEnrollment',
        'cancelHostedEnrollment',
      ]),
    );
    // Never `replace`: the hook answers a code already waiting, as Enroll does.
    expect(link.commands.find((c) => c.cmd === 'beginHostedEnrollment')?.params).toEqual({ label: 'Laptop' });
    // No Relay argument: the service enrolls only at the build's baked origin.
    expect(link.commands.find((c) => c.cmd === 'enroll')?.params).toEqual({
      password: 'password',
      label: 'Laptop',
    });
  });

  it('mirrors the service queue and answers by clientId', async () => {
    const link = fakeLink();
    const { pairing } = await installBridge(link);

    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', pairingId: 'p1', label: 'iPhone Safari', requestedAt: 5 }],
    });

    const head = pairing.getPairingApprovalSnapshot()[0]!;
    expect(head).toMatchObject({
      clientId: 'c1',
      pairingId: 'p1',
      label: 'iPhone Safari',
      requestedAt: 5,
    });

    // The digits a person read off the phone and typed here; only the Burrow
    // knows what they should be, so the webview can do nothing but echo them.
    head.approve('47');
    expect(link.commands.at(-1)).toEqual({
      cmd: 'approve',
      params: { kind: 'pairing', clientId: 'c1', pairingId: 'p1', code: '47' },
    });
    head.deny();
    expect(link.commands.at(-1)).toEqual({
      cmd: 'deny',
      params: { kind: 'pairing', clientId: 'c1', pairingId: 'p1' },
    });
  });

  it('replaces the mirror wholesale — the service is authoritative', async () => {
    const link = fakeLink();
    const { pairing } = await installBridge(link);
    const queue = (ids: string[]) => ({
      name: 'pairing-queue',
      queue: ids.map((clientId) => ({
        clientId,
        pairingId: `pairing-${clientId}`,
        label: 'iPhone Safari',
        requestedAt: 5,
      })),
    });

    link.emit('pairing-queue', queue(['c1', 'c2']));
    expect(pairing.getPairingApprovalSnapshot().map((p) => p.clientId)).toEqual(['c1', 'c2']);

    // c1 resolved on the service side; the snapshot that no longer names it is
    // the only signal, and the order of what remains must not churn.
    link.emit('pairing-queue', queue(['c2']));
    expect(pairing.getPairingApprovalSnapshot().map((p) => p.clientId)).toEqual(['c2']);

    link.emit('pairing-queue', queue([]));
    expect(pairing.getPairingApprovalSnapshot()).toEqual([]);
  });

  it('re-mirrors a request the service replaced under the same clientId', async () => {
    // The service coalesces a re-sent pairing by clientId, so the same id can
    // come to name a different device. Confirming authorizes what the *service*
    // holds, so a mirror that skipped the update would show device #1 while the
    // typed digits authorized device #2 (docs/specs/remote-security-model.md).
    const link = fakeLink();
    const { pairing } = await installBridge(link);

    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', pairingId: 'p1', label: 'iPhone Safari', requestedAt: 5 }],
    });
    const stale = pairing.getPairingApprovalSnapshot()[0]!;
    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', pairingId: 'p2', label: 'Android Chrome', requestedAt: 9 }],
    });

    const head = pairing.getPairingApprovalSnapshot();
    expect(head).toHaveLength(1);
    expect(head[0]).toMatchObject({
      clientId: 'c1',
      pairingId: 'p2',
      label: 'Android Chrome',
      requestedAt: 9,
    });

    // Digits already typed against the old modal stay bound to the old ticket;
    // the service can reject them instead of applying them to the replacement.
    stale.approve('47');
    expect(link.commands.at(-1)).toEqual({
      cmd: 'approve',
      params: { kind: 'pairing', clientId: 'c1', pairingId: 'p1', code: '47' },
    });
  });

  it('leaves an unchanged request alone, so the modal does not churn', async () => {
    // Every snapshot arrives as fresh JSON, so "unchanged" has to be decided by
    // value — comparing identity would re-render the modal on every event.
    const link = fakeLink();
    const { pairing } = await installBridge(link);
    const snapshot = () => ({
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', pairingId: 'p1', label: 'iPhone Safari', requestedAt: 5 }],
    });

    link.emit('pairing-queue', snapshot());
    const first = pairing.getPairingApprovalSnapshot()[0];
    link.emit('pairing-queue', snapshot());
    expect(pairing.getPairingApprovalSnapshot()[0]).toBe(first);

    // A distinct ceremony can look identical and land in the same millisecond;
    // its ticket still has to replace the closures that answer the old one.
    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', pairingId: 'p2', label: 'iPhone Safari', requestedAt: 5 }],
    });
    expect(pairing.getPairingApprovalSnapshot()[0]).not.toBe(first);
    expect(pairing.getPairingApprovalSnapshot()[0]!.pairingId).toBe('p2');
  });

  it('seeds the mirror, for a webview that reloaded mid-pairing', async () => {
    const link = fakeLink();
    link.results.pairingQueue = [
      { clientId: 'c1', pairingId: 'p1', label: 'iPhone Safari', requestedAt: 5 },
    ];
    const { pairing } = await installBridge(link);

    expect(link.commands.some((c) => c.cmd === 'pairingQueue')).toBe(true);
    expect(pairing.getPairingApprovalSnapshot()).toHaveLength(1);
  });

  it('re-seeds the mirror every time a Burrow appears, not only at install', async () => {
    // Joining a Burrow that is already mid-pairing is the case a one-shot seed
    // misses: the service pushes the queue only when it changes, so the modal
    // would stay hidden until the pairing was answered somewhere else.
    const link = fakeLink();
    link.results.status = { enrolled: false };
    link.results.pairingQueue = [
      { clientId: 'c1', pairingId: 'p1', label: 'iPhone Safari', requestedAt: 5 },
    ];
    const { pairing } = await installBridge(link);
    expect(link.commands.some((c) => c.cmd === 'pairingQueue')).toBe(false);

    link.emit('status', { name: 'status', enrolled: true });
    await settle();
    expect(pairing.getPairingApprovalSnapshot()).toHaveLength(1);

    // And again after the Burrow goes and comes back.
    link.emit('status', { name: 'status', enrolled: false });
    link.commands.length = 0;
    link.emit('status', { name: 'status', enrolled: true });
    await settle();
    expect(link.commands.filter((c) => c.cmd === 'pairingQueue')).toHaveLength(1);
  });

  it('asks the service for the device list the dialog names', async () => {
    const link = fakeLink();
    await installBridge(link);

    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(true);
    // And the dialog can ask again later.
    link.commands.length = 0;
    devices.refreshers.at(-1)!();
    await Promise.resolve();
    expect(link.commands.map((c) => c.cmd)).toEqual(['pushDevices']);
  });

  it('arms nothing at all on a burrow that never enrolled', async () => {
    // The common case: no device fetch, no queue seed, and no crossing per
    // activity change — only the one `status` that says so.
    const link = fakeLink();
    link.results.status = { enrolled: false };
    await installBridge(link);

    expect(link.commands.some((c) => c.cmd === 'pairingQueue')).toBe(false);
    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(false);
    expect(link.commands.some((c) => c.cmd === 'status')).toBe(true);
  });

  it('arms when the service announces a Burrow, and disarms when it goes', async () => {
    const link = fakeLink();
    link.results.status = { enrolled: false };
    await installBridge(link);

    // An enroll from any webview reaches every webview as this event.
    link.emit('status', { name: 'status', enrolled: true });
    await settle();
    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(true);

    // `clearEnrollment` announces the same way.
    link.emit('status', { name: 'status', enrolled: false });
    // The dialog must stop naming devices nothing can push to — including any
    // list still on the wire, which would otherwise put them back on arrival.
    expect(devices.cleared).toBe(1);
    // The refresher stays installed rather than being dropped and put back: the
    // dialog may still open on an un-enrolled machine, where asking is one
    // command that answers `no-burrow`.
    expect(devices.refreshers).toHaveLength(1);
    link.commands.length = 0;
    devices.refreshers.at(-1)!();
    await settle();
    expect(link.commands.map((c) => c.cmd)).toEqual(['pushDevices']);
  });

  it('keys the mirror by kind and client, so a one-time request stands apart', async () => {
    // A one-time request has no Relay and so no client id; it must never be
    // taken for, or coalesce with, a pairing — and its answers must say which
    // half of the service holds it.
    const link = fakeLink();
    const { pairing } = await installBridge(link);
    const pairingItem = { kind: 'pairing', clientId: 'c1', pairingId: 'p1', label: 'iPad', requestedAt: 5 };
    const oneTimeItem = { kind: 'one-time', clientId: '', pairingId: 't1', label: 'iPhone', requestedAt: 6 };
    // A pairing whose id happens to match the one-time request's.
    const blankPairing = { ...pairingItem, clientId: '', pairingId: 'p0' };

    link.emit('pairing-queue', { name: 'pairing-queue', queue: [pairingItem, blankPairing, oneTimeItem] });
    expect(pairing.getPairingApprovalSnapshot().map((p) => [p.kind, p.clientId])).toEqual([
      ['pairing', 'c1'],
      ['pairing', ''],
      ['one-time', ''],
    ]);

    const oneTime = pairing.getPairingApprovalSnapshot().at(-1)!;
    oneTime.approve('42');
    expect(link.commands.at(-1)).toEqual({
      cmd: 'approve',
      params: { kind: 'one-time', clientId: '', pairingId: 't1', code: '42' },
    });
    oneTime.deny();
    expect(link.commands.at(-1)).toEqual({
      cmd: 'deny',
      params: { kind: 'one-time', clientId: '', pairingId: 't1' },
    });

    // The one-time request answered: only it goes.
    link.emit('pairing-queue', { name: 'pairing-queue', queue: [pairingItem, blankPairing] });
    expect(pairing.getPairingApprovalSnapshot().map((p) => [p.kind, p.clientId])).toEqual([
      ['pairing', 'c1'],
      ['pairing', ''],
    ]);
  });

  it('reads an item that names no kind as a pairing, and answers it as one', async () => {
    // A broker from before the field: nothing it sends can be a one-time
    // request, and an answer naming `pairing` fails closed on the new service.
    const link = fakeLink();
    const { pairing } = await installBridge(link);
    link.emit('pairing-queue', {
      name: 'pairing-queue',
      queue: [{ clientId: 'c1', pairingId: 'p1', label: 'iPad', requestedAt: 5 }],
    });

    const head = pairing.getPairingApprovalSnapshot()[0]!;
    expect(head.kind).toBe('pairing');
    head.approve('47');
    expect(link.commands.at(-1)).toMatchObject({ params: { kind: 'pairing', clientId: 'c1' } });
  });

  it('seeds the mirror while serving un-enrolled, and fetches no devices', async () => {
    // A one-time connection needs the approval modal and no Relay: the queue
    // arms on `serving`, the Relay's device list on `enrolled` alone.
    const link = fakeLink();
    link.results.status = { enrolled: false, serving: false };
    link.results.pairingQueue = [
      { kind: 'one-time', clientId: '', pairingId: 't1', label: 'iPhone', requestedAt: 5 },
    ];
    const { pairing } = await installBridge(link);
    link.emit('status', { name: 'status', enrolled: false, serving: true });
    await settle();

    expect(pairing.getPairingApprovalSnapshot()).toHaveLength(1);
    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(false);
    // One seed for both gates: the un-enrolled `status` reads the offer file.
    expect(link.commands.filter((c) => c.cmd === 'status')).toHaveLength(1);

    // Enrolling while serving arms the devices without re-seeding the queue.
    link.commands.length = 0;
    link.emit('status', { name: 'status', enrolled: true, serving: true });
    await settle();
    expect(link.commands.map((c) => c.cmd)).toEqual(['pushDevices']);
  });

  it('reads a status with no `serving` as serving exactly when enrolled', async () => {
    // What a broker from before one-time connections sends.
    const link = fakeLink();
    link.results.status = { enrolled: true };
    await installBridge(link);
    expect(link.commands.some((c) => c.cmd === 'pairingQueue')).toBe(true);
    expect(link.commands.some((c) => c.cmd === 'pushDevices')).toBe(true);
  });

  it('is idempotent under a StrictMode double mount', async () => {
    const link = fakeLink();
    const { mod } = await installBridge(link);
    const before = link.commands.length;

    mod.installBurrowConsoleHook();
    await Promise.resolve();
    expect(link.commands).toHaveLength(before);
  });
});

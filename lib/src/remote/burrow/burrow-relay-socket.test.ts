/**
 * The relay socket policy with reconnection on (`docs/specs/relay.md` ->
 * "Burrow side"): which closes latch, and the standing probe a socket that
 * never opened earns before its next backoff. Every timer runs on an injected
 * clock, so "arms no timer" is a count rather than a wait.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  toBase64Url,
  WS_CLOSE_BURROW_NOT_ENTITLED,
  WS_CLOSE_BURROW_REPLACED,
  WS_CLOSE_BURROW_REVOKED,
} from 'remote-lib-common';
import type { BurrowStanding } from './burrow-fetch';
import { BurrowRuntime } from './burrow-runtime';
import type { BurrowEnrollment } from './enrollment';
import { FakeSocket } from '../test-fake-socket';
import { createTestClock } from '../test-timers';
import { settle } from '../test-e2e-client';

const ORIGIN = 'https://burrow-machine.example';

const enrollment: BurrowEnrollment = {
  relayUrl: ORIGIN,
  burrowId: 'burrow-1',
  burrowToken: 'tok',
  origin: ORIGIN,
  rpId: 'burrow.example',
  label: 'Laptop',
  // Shapes, not real keys: no Client completes a handshake here.
  noiseStaticPrivateKey: toBase64Url(new Uint8Array(48)),
  noiseStaticPublicKey: toBase64Url(new Uint8Array(32)),
};

/** A probe answering each call from `answers`, in order, and counting them. */
function scriptedProbe(...answers: Array<BurrowStanding | null | 'no-answer'>) {
  const pending: Array<(answer: BurrowStanding | null | 'no-answer') => void> = [];
  const probe = {
    calls: 0,
    /** Hold the next answer until {@link answer} releases it. */
    held: false,
    run: (): Promise<BurrowStanding | null> => {
      probe.calls += 1;
      const settleWith = (answer: BurrowStanding | null | 'no-answer') =>
        answer === 'no-answer' ? Promise.reject(new Error('no answer')) : Promise.resolve(answer);
      if (probe.held) return new Promise((resolve, reject) => {
        pending.push((answer) => void settleWith(answer).then(resolve, reject));
      });
      return settleWith(answers.shift() ?? null);
    },
    answer: (value: BurrowStanding | null | 'no-answer') => pending.shift()?.(value),
  };
  return probe;
}

describe('BurrowRuntime relay socket policy', () => {
  let clock: ReturnType<typeof createTestClock>;
  let sockets: FakeSocket[];
  let connects: Array<{ url: string; bearer?: string }>;
  let burrow: BurrowRuntime;

  beforeEach(() => {
    clock = createTestClock(1_700_000_000_000);
    connects = [];
    sockets = [];
  });

  afterEach(() => burrow.stop());

  function makeBurrow(probe?: () => Promise<BurrowStanding | null>): BurrowRuntime {
    burrow = new BurrowRuntime({
      enrollment,
      createWebSocket: (url, bearer) => {
        connects.push({ url, bearer });
        const socket = new FakeSocket();
        sockets.push(socket);
        return socket;
      },
      createSession: () => ({ handle: () => {}, dispose: () => {} }),
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: () => {},
      dismissApproval: () => {},
      now: clock.now,
      setTimer: clock.setTimer,
      ...(probe ? { probeStanding: probe } : {}),
    });
    burrow.start();
    return burrow;
  }

  /** The upgrade refused: an error event, then a close, never an open. */
  function refuse(socket: FakeSocket = sockets.at(-1)!): void {
    socket.emitError();
    socket.closeWith(1006);
  }

  it('keeps the bearer out of the URL on connect and refused-upgrade retries', () => {
    makeBurrow();
    refuse();
    clock.advance(60_000);
    expect(connects.length).toBeGreaterThan(1);
    for (const connection of connects) expect(connection).toEqual({
      url: ORIGIN.replace(/^http/, 'ws') + '/ws/burrow', bearer: enrollment.burrowToken,
    });
  });

  it('latches on 4000 and 4001, arming no timer and opening nothing until start()', () => {
    for (const [code, latch] of [
      [WS_CLOSE_BURROW_REPLACED, 'displaced'],
      [WS_CLOSE_BURROW_REVOKED, 'removed'],
    ] as const) {
      sockets = [];
      makeBurrow();
      sockets[0]!.open();
      sockets[0]!.closeWith(code);
      expect(burrow.status).toBe(latch);
      expect(clock.armed).toBe(0);
      clock.advance(60_000);
      expect(sockets).toHaveLength(1);

      burrow.start();
      expect(sockets).toHaveLength(2);
      expect(burrow.status).toBe('connecting');
      burrow.stop();
    }
  });

  it('backs off and reconnects after any other close', () => {
    makeBurrow();
    sockets[0]!.open();
    sockets[0]!.drop();
    expect(burrow.status).toBe('disconnected');
    clock.advance(1_000);
    expect(sockets).toHaveLength(2);
  });

  it('latches what the probe of a refused upgrade answers, opening nothing more', async () => {
    for (const standing of ['removed', 'not-entitled'] as const) {
      sockets = [];
      const probe = scriptedProbe(standing, standing);
      makeBurrow(probe.run);
      refuse();
      await settle();
      expect(probe.calls).toBe(1);
      expect(burrow.status).toBe(standing);
      // Only not-entitled asks again, and only its standing.
      expect(clock.armed).toBe(standing === 'removed' ? 0 : 1);
      clock.advance(60_000);
      await settle();
      expect(probe.calls).toBe(standing === 'removed' ? 1 : 2);
      expect(sockets).toHaveLength(1);
      burrow.stop();
    }
  });

  it('asks a not-entitled standing again after a minute, and reconnects once the Relay takes it', async () => {
    const probe = scriptedProbe(null);
    makeBurrow(probe.run);
    sockets[0]!.open();
    sockets[0]!.closeWith(WS_CLOSE_BURROW_NOT_ENTITLED);
    expect(burrow.status).toBe('not-entitled');
    expect(clock.armed).toBe(1);
    clock.advance(59_999);
    await settle();
    expect(probe.calls).toBe(0);
    clock.advance(1);
    await settle();
    expect(probe.calls).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(burrow.status).toBe('connecting');
    sockets[1]!.open();
    expect(burrow.status).toBe('connected');
  });

  it('doubles the wait while the Relay still refuses, to half an hour, asking nothing else', async () => {
    const probe = scriptedProbe(...Array<BurrowStanding>(8).fill('not-entitled'));
    makeBurrow(probe.run);
    sockets[0]!.open();
    sockets[0]!.closeWith(WS_CLOSE_BURROW_NOT_ENTITLED);
    const minutes = [1, 2, 4, 8, 16, 30, 30];
    for (const [index, wait] of minutes.entries()) {
      clock.advance(wait * 60_000 - 1);
      await settle();
      expect(probe.calls).toBe(index);
      clock.advance(1);
      await settle();
      expect(probe.calls).toBe(index + 1);
      expect(burrow.status).toBe('not-entitled');
    }
    // Only the probe: no socket, no reconnect.
    expect(sockets).toHaveLength(1);
  });

  it('stops asking on stop(), and on a later removal', async () => {
    const probe = scriptedProbe('removed');
    makeBurrow(probe.run);
    sockets[0]!.open();
    sockets[0]!.closeWith(WS_CLOSE_BURROW_NOT_ENTITLED);
    clock.advance(60_000);
    await settle();
    expect(burrow.status).toBe('removed');
    expect(clock.armed).toBe(0);

    burrow.start();
    sockets.at(-1)!.open();
    sockets.at(-1)!.closeWith(WS_CLOSE_BURROW_NOT_ENTITLED);
    expect(clock.armed).toBe(1);
    burrow.stop();
    expect(clock.armed).toBe(0);
    clock.advance(30 * 60_000);
    await settle();
    expect(probe.calls).toBe(1);
  });

  it('probes once per failure streak, and again once a socket has opened', async () => {
    const probe = scriptedProbe(null, null);
    makeBurrow(probe.run);
    refuse();
    await settle();
    expect(probe.calls).toBe(1);
    expect(burrow.status).toBe('disconnected');

    // Still refused, and the streak's probe is spent: backoff alone.
    clock.advance(1_000);
    refuse();
    await settle();
    expect(probe.calls).toBe(1);
    clock.advance(2_000);
    expect(sockets).toHaveLength(3);

    // An open ends the streak; the next refusal is a new one.
    sockets[2]!.open();
    sockets[2]!.drop();
    expect(probe.calls).toBe(1);
    clock.advance(1_000);
    refuse();
    await settle();
    expect(probe.calls).toBe(2);
  });

  it('never probes a socket that opened and then closed', async () => {
    const probe = scriptedProbe('removed');
    makeBurrow(probe.run);
    sockets[0]!.open();
    sockets[0]!.drop();
    await settle();
    expect(probe.calls).toBe(0);
    expect(burrow.status).toBe('disconnected');
  });

  it('spends no probe on one that got no answer, and backs off meanwhile', async () => {
    const probe = scriptedProbe('no-answer', 'removed');
    makeBurrow(probe.run);
    refuse();
    await settle();
    expect(probe.calls).toBe(1);
    expect(burrow.status).toBe('disconnected');
    clock.advance(1_000);
    refuse();
    await settle();
    expect(probe.calls).toBe(2);
    expect(burrow.status).toBe('removed');
  });

  it('arms nothing while the probe is out, and drops an answer that lands after a stop or a start', async () => {
    const probe = scriptedProbe();
    probe.held = true;
    makeBurrow(probe.run);
    refuse();
    expect(clock.armed).toBe(0);
    burrow.stop();
    burrow.start();
    expect(sockets).toHaveLength(2);
    probe.answer('removed');
    await settle();
    expect(burrow.status).toBe('connecting');

    refuse();
    expect(probe.calls).toBe(2);
    burrow.stop();
    probe.answer(null);
    await settle();
    expect(burrow.status).toBe('stopped');
    expect(clock.armed).toBe(0);
  });
});

describe('BurrowRuntime transport', () => {
  afterEach(() => vi.unstubAllGlobals());

  // The factory is the Burrow service's policy-guarded one
  // (`docs/specs/remote-network.md` -> "Policy"); a caller that omits it gets no
  // socket, never one opened around the guard.
  it('has no default socket factory to fall back on', () => {
    const globalSocket = vi.fn();
    vi.stubGlobal('WebSocket', globalSocket);
    const options = {
      enrollment,
      reconnect: false,
      loadAcl: () => [],
      saveAcl: () => {},
      requestApproval: () => {},
      dismissApproval: () => {},
    };
    const burrow = new BurrowRuntime(options as unknown as ConstructorParameters<typeof BurrowRuntime>[0]);
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      burrow.start();
    } finally {
      burrow.stop();
      warn.mockRestore();
    }
    expect(globalSocket).not.toHaveBeenCalled();
  });
});

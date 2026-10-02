import { describe, expect, it, vi } from 'vitest';
import { RELAY_PING, RELAY_PONG } from 'remote-lib-common';

import { fakeTimers } from './test-timers';
import { RelayHeartbeat, type RemoteWebSocket } from './ws';

/** A socket that keeps what it was sent. */
function socket() {
  const sent: string[] = [];
  const ws: RemoteWebSocket = {
    send: (data) => void sent.push(data),
    close: () => {},
    addEventListener: () => {},
    readyState: 1,
  };
  return { ws, sent };
}

// The relay socket's heartbeat (docs/specs/relay.md -> "Routing"); the Burrow's
// and Pocket's own suites drive it through their sockets.
describe('RelayHeartbeat', () => {
  it('reads the pong, and only the pong, as its own', () => {
    const timers = fakeTimers();
    const heartbeat = new RelayHeartbeat(socket().ws, timers.setTimer, () => {});
    expect(heartbeat.read(RELAY_PONG)).toBe(true);
    for (const data of [RELAY_PING, '"pong"', '{}', undefined, new ArrayBuffer(4)])
      expect(heartbeat.read(data)).toBe(false);
  });

  it('with onDead, ends a socket whose ping is unanswered when the next is due', () => {
    const timers = fakeTimers();
    const { ws, sent } = socket();
    const onDead = vi.fn();
    const heartbeat = new RelayHeartbeat(ws, timers.setTimer, onDead);
    timers.fire();
    heartbeat.read(RELAY_PONG);
    timers.fire();
    expect(onDead).not.toHaveBeenCalled();
    timers.fire();
    expect(onDead).toHaveBeenCalledOnce();
    expect(sent).toEqual([RELAY_PING, RELAY_PING]);
    expect(timers.live).toHaveLength(0);
  });

  it('with onDead, holds even the first ping to the deadline', () => {
    const timers = fakeTimers();
    const { ws, sent } = socket();
    const onDead = vi.fn();
    new RelayHeartbeat(ws, timers.setTimer, onDead);
    timers.fire();
    timers.fire();
    expect(onDead).toHaveBeenCalledOnce();
    expect(sent).toEqual([RELAY_PING]);
  });

  it('without onDead, only keeps the path alive', () => {
    const timers = fakeTimers();
    const { ws, sent } = socket();
    const heartbeat = new RelayHeartbeat(ws, timers.setTimer);
    timers.fire();
    heartbeat.read(RELAY_PONG);
    for (let i = 0; i < 4; i += 1) timers.fire();
    expect(sent).toHaveLength(5);
    expect(timers.live).toHaveLength(1);
    heartbeat.stop();
    expect(timers.live).toHaveLength(0);
  });
});

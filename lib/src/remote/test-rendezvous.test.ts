import { describe, expect, it } from 'vitest';
import {
  MAX_ONE_TIME_FORWARDED,
  ONE_TIME_WS_ROUTES,
  WS_CLOSE_ONE_TIME_EXPIRED,
  WS_CLOSE_ONE_TIME_TAKEN,
  WS_CLOSE_ONE_TIME_UNAVAILABLE,
  WS_CLOSE_ONE_TIME_VIOLATION,
} from 'remote-lib-common';
import { createTestRendezvous } from './test-rendezvous';
import { createTestClock } from './test-timers';

// The fake must close as Hosted's `OneTimeRoom` does (`hosted/server/one-time-room.ts`;
// `docs/specs/one-time.md` -> "Hosted rendezvous"): the phone reads its copy off the code.
describe('test rendezvous parity with the one-time room', () => {
  const START = 1_700_000_000_000;
  async function mint() {
    const clock = createTestClock(START);
    const rendezvous = createTestRendezvous({ now: clock.now, setTimer: clock.setTimer });
    rendezvous.createBurrowSocket(`wss://hosted.invalid${ONE_TIME_WS_ROUTES.burrow}`);
    await Promise.resolve();
    const room = rendezvous.room();
    const join = async () => {
      const socket = rendezvous.createClientSocket(rendezvous.clientUrl(room.roomId));
      await Promise.resolve();
      return socket;
    };
    return { clock, rendezvous, room, join };
  }

  it('refuses an unknown room 4012, a joined one 4011, and a join past expiresAt 4010', async () => {
    const { clock, rendezvous, room, join } = await mint();
    const unknown = rendezvous.createClientSocket(rendezvous.clientUrl('nope'));
    await Promise.resolve();
    expect(unknown.closeCode).toBe(WS_CLOSE_ONE_TIME_UNAVAILABLE);

    clock.jump(room.expiresAt + 1 - clock.now());
    expect((await join()).closeCode).toBe(WS_CLOSE_ONE_TIME_EXPIRED);

    const late = await mint();
    expect((await late.join()).closeCode).toBeNull();
    late.clock.jump(late.room.expiresAt + 1 - late.clock.now());
    expect((await late.join()).closeCode).toBe(WS_CLOSE_ONE_TIME_TAKEN);
  });

  it('counts a frame sent before any phone joins toward the cap', async () => {
    const { room } = await mint();
    for (let i = 0; i < MAX_ONE_TIME_FORWARDED; i += 1) room.burrow.send(`frame ${i}`);
    expect(room.forwarded).toBe(MAX_ONE_TIME_FORWARDED);
    expect(room.burrow.closeCode).toBeNull();
    room.burrow.send('one past the cap');
    expect(room.burrow.closeCode).toBe(WS_CLOSE_ONE_TIME_VIOLATION);
  });
});

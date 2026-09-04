/** A manually-advanced clock, so a TTL or refill is asserted rather than waited out. */
export function makeClock(startMs = 1_700_000_000_000) {
  let ms = startMs;
  return {
    now: () => ms,
    advance(delta) {
      ms += delta;
    },
  };
}

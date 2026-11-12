/**
 * Freezes the clock for an Argos run, before any story module loads: a
 * timestamp in a `parameters` literal is built at module load, so a pin in a
 * story's `beforeEach` comes too late for it. `preview.ts` imports this first.
 * A story reads `Date.now()` anywhere and never pins a clock of its own.
 *
 * Noon, so "an hour ago" and "two hours ago" fall on the same day.
 */
declare const __ARGOS_SNAPSHOT__: true | undefined;

const SNAPSHOT_NOW = Date.UTC(2026, 0, 15, 12);

if (typeof __ARGOS_SNAPSHOT__ !== 'undefined') {
  Date.now = () => SNAPSHOT_NOW;
  globalThis.Date = new Proxy(Date, {
    construct: (target, args, newTarget) =>
      Reflect.construct(target, args.length === 0 ? [target.now()] : args, newTarget),
    apply: (target) => new target(target.now()).toString(),
  });
}

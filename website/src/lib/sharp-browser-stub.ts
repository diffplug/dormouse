/*
 * Browser stub for `sharp`, aliased in `vite.config.ts`.
 *
 * ascii-splash's `patterns/PatternCatalog.js` — the upstream pattern registry
 * the playground reuses — statically imports `PhotoPattern`, which statically
 * imports `sharp` (a Node native module). PhotoPattern only touches `sharp`
 * inside method bodies, and the playground never passes a `photoPattern` to
 * `buildPatternSlots`, so the import is load-bearing at module scope only.
 * Aliasing it to this stub keeps the native module out of the browser bundle;
 * calling it is a bug, so it throws.
 */
function unavailable(): never {
  throw new Error("sharp is not available in the browser playground");
}

export default unavailable;

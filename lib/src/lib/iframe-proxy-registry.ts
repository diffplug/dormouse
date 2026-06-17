/**
 * Tracks the loopback proxy origins of live iframe surfaces so the Wall's
 * keyboard/focus channel can trust `postMessage` events from instrumented
 * frames (docs/specs/dor-iframe.md → "The keyboard side-channel"). The shim we
 * inject calls `parent.postMessage(...)`, which is cross-origin-safe by design;
 * the Wall validates `event.origin` against this set before acting on a
 * forwarded leader chord or focus/blur, so only a frame Dormouse itself served
 * can drive those paths.
 *
 * Reference-counted because a surface can briefly re-register the same origin
 * across a webview reload (mount of the new panel before unmount of the old).
 */
const proxyOriginCounts = new Map<string, number>();

export function registerProxyOrigin(origin: string): () => void {
  proxyOriginCounts.set(origin, (proxyOriginCounts.get(origin) ?? 0) + 1);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    const next = (proxyOriginCounts.get(origin) ?? 1) - 1;
    if (next <= 0) proxyOriginCounts.delete(origin);
    else proxyOriginCounts.set(origin, next);
  };
}

export function isProxyOrigin(origin: string): boolean {
  return proxyOriginCounts.has(origin);
}

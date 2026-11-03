/**
 * Tracks the loopback proxy origins of live iframe surfaces so the Wall's
 * keyboard/focus channel can trust `postMessage` events from instrumented
 * frames (docs/specs/dor-browser.md → "Iframe Shim"). The shim we
 * inject calls `parent.postMessage(...)`, which is cross-origin-safe by design;
 * the Wall validates `event.origin` against this set before acting on a
 * forwarded leader chord, so only a frame Dormouse itself served can send one.
 *
 * A plain Set suffices: each proxied surface gets its own ephemeral loopback
 * origin (a unique OS-assigned port per grant), so an origin is only ever held
 * by one live surface at a time — there's nothing to reference-count.
 */
const proxyOrigins = new Set<string>();

export function registerProxyOrigin(origin: string): () => void {
  proxyOrigins.add(origin);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    proxyOrigins.delete(origin);
  };
}

export function isProxyOrigin(origin: string): boolean {
  return proxyOrigins.has(origin);
}

/**
 * Whether a message came from the frame holding this document's focus. An origin
 * check cannot say: a framed page shares its shim's origin and can post any shim
 * message with no gesture, so a message that moves the Wall's selection or mode
 * must pass this as well (docs/specs/security-local.md -> "Browser panes").
 */
export function isFromFocusedFrame(event: MessageEvent): boolean {
  const focused = document.activeElement;
  return focused instanceof HTMLIFrameElement && event.source === focused.contentWindow;
}

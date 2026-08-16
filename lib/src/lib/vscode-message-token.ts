/**
 * Authenticates extension-host → webview `postMessage` traffic in the VS Code
 * host (`docs/specs/vscode.md` → "Webview message authentication").
 *
 * A webview's `window` receives `message` events from two very different
 * senders: the extension host (trusted — it owns the PTYs) and any framed
 * content, which reaches the top document with `parent.postMessage(...)`.
 * Cross-origin frames can post freely by design, so `event.data.type` alone
 * says nothing about who sent it — and the adapter turns some of those types
 * into PTY writes.
 *
 * So the host mints a fresh CSPRNG token per webview boot, injects it into the
 * document through the same nonce-gated inline script that seeds the other
 * `__DORMOUSE_*` globals, and stamps it on every message it posts. A frame
 * cannot read the parent's globals across origins, so it cannot produce the
 * token, and the adapter drops anything that doesn't carry it.
 *
 * This is the same shape as `iframe-proxy-registry.ts` — a tiny module holding
 * the trust criterion so the listener stays a one-line guard — but keyed on an
 * unguessable secret rather than an origin, because the VS Code host's internal
 * frame topology is not something the webview can verify.
 *
 * Deliberately not the CSP nonce: that one authorizes script execution, this
 * one authenticates a message sender. Separate purposes, separate secrets.
 */

/** Global the host injects the per-boot token into. */
export const HOST_MESSAGE_TOKEN_GLOBAL = '__DORMOUSE_MESSAGE_TOKEN__';

/** Envelope field every host-originated message carries. */
export const HOST_MESSAGE_TOKEN_FIELD = '__dormouseToken';

/**
 * Read the injected token. Returns `null` when the global is absent or not a
 * non-empty string, which makes {@link isHostMessage} reject everything — a
 * webview served without a token fails closed rather than open.
 */
export function readHostMessageToken(): string | null {
  const raw = (globalThis as typeof globalThis & {
    __DORMOUSE_MESSAGE_TOKEN__?: unknown;
  })[HOST_MESSAGE_TOKEN_GLOBAL];
  return typeof raw === 'string' && raw.length > 0 ? raw : null;
}

/**
 * True when `data` is a message envelope stamped with `token`.
 *
 * A plain `===` is enough here: the token is compared against a value the
 * sender chose, and neither branch reports anything back to a frame, so there
 * is no oracle to time. Comparing against a string also rejects a coerced
 * lookalike (an object with a `toString`) outright.
 */
export function isHostMessage(data: unknown, token: string | null): boolean {
  if (!token) return false;
  if (typeof data !== 'object' || data === null) return false;
  return (data as Record<string, unknown>)[HOST_MESSAGE_TOKEN_FIELD] === token;
}

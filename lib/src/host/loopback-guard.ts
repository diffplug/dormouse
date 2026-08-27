/**
 * The shared rule for every loopback listener Dormouse binds.
 *
 * **A loopback bind is not an access control.** `127.0.0.1` keeps out the
 * network, but the attacker that matters is a web page open in the user's own
 * browser, and that page reaches loopback exactly as easily as our own webview
 * does. An ephemeral port is not a secret either — the range scans in seconds.
 * So every such listener has to answer two questions on every request:
 *
 *   1. **Was I addressed by my own loopback name?** (`isLoopbackHost`)
 *      A hostile domain re-pointed at 127.0.0.1 — DNS rebinding — arrives with
 *      its own name still in `Host`, and the browser considers that
 *      same-origin, so no CORS header ever gets a say. Checking `Host` is what
 *      makes rebinding fail.
 *   2. **Do I recognize this caller?** (`isOwnOrigin`, or a credential)
 *      The mechanism differs per listener because their URLs differ; what may
 *      not differ is that an unrecognized caller gets no privilege.
 *
 * The three listeners and how each answers (2):
 *   - VS Code agent-browser stream relay — a single-use 64-hex token in the
 *     upgrade path, 60s TTL, bound to one target port
 *     (`vscode-ext/src/agent-browser-host.ts`). It deliberately does *not* call
 *     `isLoopbackHost`, and that is not an oversight: rebinding exists to let a
 *     hostile page issue same-origin-looking requests to loopback, which buys
 *     nothing against a listener that already demands an unguessable one-shot
 *     token. It also drops `Origin` outright rather than rewriting it, so it
 *     never vouches for anyone. A Host check there would be code that defends
 *     nothing.
 *   - Iframe proxy — `isOwnOrigin`, because a URL token is unworkable here: it
 *     would land in `location.pathname` and break client-side routers, and it
 *     would not survive onto root-relative sub-resource requests at all
 *     (`./iframe-proxy.ts`).
 *   - Browser-dev bridge — a per-run token in the URL query, which works
 *     because the harness owns the page's URL
 *     (`standalone/scripts/dev-agent-browser.mjs`). That one keeps its own copy
 *     of these checks rather than importing this module: it is a dev-only,
 *     unbundled script in another package, and making it depend on built TS to
 *     share a few lines would cost more than the duplication does.
 *
 * `SECURITY.md` → "Loopback listeners" states this as an audited invariant, so
 * a fourth listener is caught by the audit rather than by luck.
 */

/**
 * True when `Host` names this listener's own loopback address. Both spellings
 * are accepted because either can appear in a hand-typed URL; neither is a
 * rebinding vector, since browsers refuse to rebind them.
 */
export function isLoopbackHost(hostHeader: string | undefined, port: number): boolean {
  const host = (hostHeader ?? '').toLowerCase();
  return host === `127.0.0.1:${port}` || host === `localhost:${port}`;
}

/**
 * True when `Origin` is this listener's own origin — i.e. the caller is a page
 * we ourselves served, not a foreign site.
 *
 * An **absent** `Origin` is not "own": browsers omit it on top-level
 * navigations and same-origin GETs, so callers must decide what absence means
 * for them rather than having this function guess.
 */
export function isOwnOrigin(originHeader: string | undefined, port: number): boolean {
  if (!originHeader) return false;
  let url: URL;
  try {
    url = new URL(originHeader);
  } catch {
    return false;
  }
  if (url.protocol !== 'http:') return false;
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') return false;
  return url.port === String(port);
}

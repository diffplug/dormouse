/**
 * The shared rule for every loopback listener Dormouse binds.
 *
 * **A loopback bind is not an access control.** `127.0.0.1` keeps out the
 * network, but the attacker that matters is a web page open in the user's own
 * browser, and that page reaches loopback exactly as easily as our own webview
 * does. An ephemeral port is not a secret either — the range scans in seconds.
 *
 * The rule is about *privilege*, not admission: no listener may grant an
 * unrecognized caller anything it could not already get by reaching the
 * upstream directly. Some listeners honour that by refusing the request; the
 * iframe proxy honours it by admitting everyone and vouching for no one. Both
 * are answers to the same two questions:
 *
 *   1. **Was I addressed by my own loopback name?** (`isLoopbackHost`)
 *      A hostile domain re-pointed at 127.0.0.1 — DNS rebinding — arrives with
 *      its own name still in `Host`, and the browser considers that
 *      same-origin, so no CORS header ever gets a say. Checking `Host` is what
 *      makes rebinding fail. A listener that already demands an unguessable
 *      one-shot token gains nothing from it, since rebinding exists only to
 *      make same-origin-looking requests, and may skip it.
 *   2. **Do I recognize this caller?** (`isOwnOrigin`, or a credential)
 *      The mechanism is forced by the listener's URL, not chosen: a token works
 *      where we own that URL, and cannot work where the URL is a page's own
 *      origin — it would land in `location.pathname`, break client-side
 *      routers, and never survive onto root-relative sub-resource requests.
 *
 * A third question has no request-header answer at all: **who is allowed to
 * frame me?** An iframe navigation carries no `Origin`, and `Sec-Fetch-Site`
 * reads `cross-site` for our own webview and for an attacker page alike — so a
 * listener whose response confers something on its *embedder* (the iframe
 * proxy's framing-header replacement, and its shim) has to name that embedder
 * and let the browser enforce it, through `frame-ancestors`. See
 * `./iframe-proxy-rewrite.ts` → `FRAMING_RESPONSE_HEADERS`.
 *
 * `SECURITY.md` → "Loopback Listeners" is the authority on which listeners
 * exist and how each answers; it is deliberately not restated here, since it
 * tells its reader to derive that set by search rather than trust a list.
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
  // An `Origin` is a *serialized* origin — scheme, host, port, nothing else —
  // so an exact compare is the whole test; parsing it would only add ways to be
  // lenient. Anything non-canonical fails, which is the safe direction: the
  // caller then declines to vouch and forwards the header untouched.
  const origin = (originHeader ?? '').toLowerCase();
  return origin === `http://127.0.0.1:${port}` || origin === `http://localhost:${port}`;
}

/**
 * True when the caller **named itself** as somebody else: an `Origin` is
 * present and is not this listener's own.
 *
 * Not the negation of {@link isOwnOrigin}, and the difference is the whole
 * point: an *absent* `Origin` is neither own nor foreign. Treating absence as
 * own would vouch for every navigation; treating it as foreign would penalize
 * the ordinary iframe case, which is precisely the one that carries no
 * `Origin`. Ask this where the question is "may this caller keep something of
 * mine alive", and {@link isOwnOrigin} where it is "may I speak for this
 * caller".
 */
export function isForeignOrigin(originHeader: string | undefined, port: number): boolean {
  return !!originHeader && !isOwnOrigin(originHeader, port);
}

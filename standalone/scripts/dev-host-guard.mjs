// The security boundary of the browser dev bridge, kept in its own module so it
// can be tested directly — `dev-agent-browser.mjs` spawns Vite, the sidecar and
// agent-browser at import time, so nothing inside it is reachable from a test.
//
// What this guards: the bridge dispatches `pty_spawn` into the sidecar with
// caller-supplied `shell`, `args`, `cwd` and `env`, so reaching it is arbitrary
// command execution as the developer. It listens on loopback, which is not a
// boundary at all against the threat that matters here — a web page open in the
// developer's own browser.
//
// The rule these checks implement is shared with Dormouse's other loopback
// listeners and is stated once in `lib/src/host/loopback-guard.ts`, with
// `docs/specs/security-local.md` -> "Loopback Listeners" auditing the class. This file keeps its
// own copy rather than importing that module: it is a dev-only, unbundled
// script in another package, and making it depend on built TS to share a few
// lines would cost more than the duplication does.
import { createHash, timingSafeEqual } from 'node:crypto';

function sha256(value) {
  return createHash('sha256').update(value).digest();
}

/**
 * Every request must carry `?t=<token>` and be addressed to loopback by name.
 *
 * The token rides in the URL rather than an `Authorization` header because
 * `EventSource` cannot set headers, and `/events` has to be gated like the
 * rest. Digests are compared because `timingSafeEqual` throws on a length
 * mismatch, which would otherwise leak the token's length and turn a wrong
 * guess into a crash instead of a refusal.
 *
 * The Host check is anti-DNS-rebind: a hostile domain re-resolved to 127.0.0.1
 * arrives here with its own name still in `Host`, and the browser considers
 * that same-origin, so the CORS headers never get a say.
 */
export function isAuthorized(req, { token, port }) {
  const host = (req.headers?.host || '').toLowerCase();
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}`) return false;
  // The content-type test belongs in the gate, not in the body reader: a route
  // that never parses a body would otherwise silently lose the one control that
  // stops a preflight-free cross-origin POST.
  if (req.method && req.method !== 'GET' && !isJsonRequest(req)) return false;
  let presented;
  try {
    presented = new URL(req.url || '/', `http://127.0.0.1:${port}`).searchParams.get('t');
  } catch {
    return false;
  }
  if (!presented) return false;
  return timingSafeEqual(sha256(presented), sha256(token));
}

/**
 * Insisting on the JSON content-type is a security control, not tidiness.
 * Without it a POST here is a CORS-*simple* request: any page in the
 * developer's browser can issue it with `mode: 'no-cors'`, and while it cannot
 * read the reply, the request still executes — which is all `pty_spawn` needs.
 * Requiring a non-simple content-type forces a preflight, which a foreign
 * origin cannot pass against the single allowed origin below.
 */
export function isJsonRequest(req) {
  const type = (req.headers?.['content-type'] || '').split(';')[0].trim().toLowerCase();
  return type === 'application/json';
}

/**
 * The dev page's origin, echoed back — never `*`. Under `*` every response was
 * readable cross-origin, which leaks the `read_clipboard_text` and
 * `read_clipboard_file_paths` invokes outright.
 *
 * Echoed rather than fixed because `http://localhost:<vite>` and
 * `http://127.0.0.1:<vite>` are the same dev page, and a developer who types
 * the other spelling would otherwise have every bridge call rejected by CORS —
 * with a blank terminal and console errors that do not point at the cause.
 * Echoing exactly one of two known-good values is as tight as pinning one:
 * anything else still gets the first spelling and fails the browser's check.
 */
export function corsHeaders(viteOrigin, requestOrigin) {
  const allowed = [viteOrigin, viteOrigin.replace('//localhost:', '//127.0.0.1:')];
  return {
    'access-control-allow-origin': allowed.includes(requestOrigin) ? requestOrigin : viteOrigin,
    vary: 'origin',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-headers': 'content-type',
  };
}

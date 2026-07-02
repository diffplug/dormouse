/**
 * Code shared between the frontend (`lib`) and the backend (`server`) — the
 * server-side counterpart to `dor-lib-common`.
 *
 * Keep this package runtime-agnostic: it is compiled into both a browser bundle
 * (via `lib`) and a Node process (`server`), so it must not reach for Node or
 * DOM globals. That is why `tsconfig.json` sets `"types": []`.
 *
 * The `security/` modules implement the primitives of
 * `docs/specs/remote-security-model.md`: device keys, host challenges,
 * passkey assertion verification, the Host ACL, the pairing ceremony, and
 * connection authorization.
 */

export * from './remote/wire.js';
export * from './security/webcrypto.js';
export * from './security/bytes.js';
export * from './security/ecdsa.js';
export * from './security/deviceKey.js';
export * from './security/challenge.js';
export * from './security/passkey.js';
export * from './security/acl.js';
export * from './security/pairing.js';
export * from './security/connection.js';

/** Path of the greeting endpoint that `server` serves and `lib` can call. */
export const HELLO_ROUTE = '/api/hello';

/** Response body returned by {@link HELLO_ROUTE}. */
export interface HelloResponse {
  readonly message: string;
}

/**
 * Build the {@link HelloResponse} for a caller. Living here — rather than in
 * `server` — keeps the frontend and backend agreeing on the exact shape.
 */
export function helloResponse(name = 'world'): HelloResponse {
  return { message: `Hello, ${name}!` };
}

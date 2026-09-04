/**
 * The Host's authenticated HTTP calls to its own Relay — push delivery
 * (`push-delivery.ts`) and setup-token minting (`lib/src/host/remote/service.ts`
 * → `#setupQr`) — under one transport policy, so neither can drift from it.
 *
 * Not the enrollment exchange: that one proves a different credential and has no
 * `hostToken` yet (`enrollment.ts`). It shares only {@link HOST_REQUEST_TIMEOUT_MS}.
 */

import type { HostEnrollment } from './enrollment';

/**
 * How long a Host→Relay call waits before it gives up, unless the caller names
 * its own budget.
 *
 * Under the webview's own 15 s command budget (`link-client.ts`), so a command
 * that ran one of these surfaces the real failure rather than a bare timeout —
 * and, for the calls that run on the service's lifecycle chain, so a Relay that
 * accepts the connection and then answers nothing cannot wedge every later
 * command for the platform's default socket timeout, which is minutes.
 *
 * **A route the Relay may legitimately hold open for longer needs its own
 * `timeoutMs`**, or a request that succeeded reports as a failure: push delivery
 * is the one such route today (`push-delivery.ts`).
 */
export const HOST_REQUEST_TIMEOUT_MS = 10_000;

export interface HostFetchOptions {
  /** Who this Host is to that Relay, and the bearer that proves it. */
  readonly enrollment: Pick<HostEnrollment, 'relayUrl' | 'hostToken'>;
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Leads the non-2xx message, which always ends in ` (<status>)`. */
  readonly errorPrefix?: string;
}

/**
 * `GET route`, or — the moment a `body` is passed — `POST route` with that body
 * as JSON, authenticated as this Host. An endpoint whose only input is the
 * bearer still posts, with `{}`.
 *
 * Throws on any non-2xx so no caller can swallow one: a send that ignored a 401
 * from a revoked host token would leave the feature permanently broken and
 * silent, which is the failure mode this path is most prone to.
 */
export async function hostFetch(
  options: HostFetchOptions,
  route: string,
  body?: unknown,
): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  const response = await doFetch(`${options.enrollment.relayUrl}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    // The service replaced a webview whose CSP checked every redirect target,
    // and a Node process re-checks nothing. Do not let an allowed origin's open
    // redirect forward the bearer token — or the notification metadata — to a
    // destination outside the baked allowlist.
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? HOST_REQUEST_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${options.enrollment.hostToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
  if (!response.ok) {
    throw new Error(`${options.errorPrefix ?? `${route} failed`} (${response.status})`);
  }
  return response;
}

/**
 * The Burrow's authenticated HTTP calls to its own Relay — push delivery
 * (`push-delivery.ts`), setup-token minting (`lib/src/host/remote/service.ts`
 * → `#setupQr`), and the standing probe ({@link probeBurrowStanding}) — under
 * one transport policy, so none can drift from it.
 *
 * Not the enrollment exchange: that one proves a different credential and has no
 * `burrowToken` yet (`enrollment.ts`). It shares only {@link BURROW_REQUEST_TIMEOUT_MS}.
 */

import {
  API_ROUTES,
  NOT_ENTITLED_ERROR,
  UNAUTHORIZED_ERROR,
  UNKNOWN_BURROW_TOKEN_ERROR,
} from 'remote-lib-common';

import type { BurrowEnrollment } from './enrollment';

/**
 * How long a Burrow→Relay call waits before it gives up, unless the caller names
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
export const BURROW_REQUEST_TIMEOUT_MS = 10_000;

/** Node's TLS verification codes, which undici puts on a failed fetch's `cause`. */
const CERTIFICATE_CODES = new Set([
  'CERT_HAS_EXPIRED',
  'CERT_NOT_YET_VALID',
  'CERT_UNTRUSTED',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'ERR_TLS_CERT_ALTNAME_INVALID',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

const TIMEOUT_CODES = new Set(['ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT']);

/** `value`'s string `code`, or that of the first error an `AggregateError` holds. */
function codeOf(value: unknown): string | null {
  if (!value || typeof value !== 'object') return null;
  const { code, errors } = value as { code?: unknown; errors?: unknown };
  if (typeof code === 'string') return code;
  return Array.isArray(errors) ? codeOf(errors[0]) : null;
}

/**
 * What a person reads for a request to `url` that never got an answer, in
 * place of undici's bare `fetch failed`: the host — never the whole URL, which
 * can carry a path a person need not see — and why, from the error's `cause`.
 * Never for an HTTP status, which got an answer and has its own sentence.
 */
export function describeFetchFailure(url: string, error: unknown): string {
  let host: string;
  try {
    host = new URL(url).host;
  } catch {
    host = 'the server';
  }
  const cause = (error as { cause?: unknown } | null)?.cause;
  const code = codeOf(cause) ?? codeOf(error);
  const name = (error as { name?: unknown } | null)?.name;
  let why: string;
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') why = 'the name doesn’t resolve';
  else if (code === 'ECONNREFUSED') why = 'the connection was refused';
  else if ((code !== null && TIMEOUT_CODES.has(code)) || name === 'TimeoutError' || name === 'AbortError') {
    why = 'it didn’t answer in time';
  } else if (code !== null && (CERTIFICATE_CODES.has(code) || code.startsWith('ERR_TLS_'))) {
    why = 'its certificate was rejected';
  } else {
    why = code ?? (cause instanceof Error ? cause.message : error instanceof Error ? error.message : String(error));
  }
  return `Couldn’t reach ${host}: ${why}.`;
}

/**
 * `fetch`, rejecting with {@link describeFetchFailure}'s sentence where the
 * request got no answer. The service's guarded fetch is built on it, so every
 * Burrow request whose failure reaches a person says where and why.
 */
export function describingFetchFailures(fetch: typeof globalThis.fetch): typeof globalThis.fetch {
  return async (input, init) => {
    try {
      return await fetch(input, init);
    } catch (error) {
      const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      // `cause` by assignment: this build's lib is ES2020, which types no `ErrorOptions`.
      throw Object.assign(new Error(describeFetchFailure(url, error)), { cause: error });
    }
  };
}

export interface BurrowFetchOptions {
  /** Who this Burrow is to that Relay, and the bearer that proves it. */
  readonly enrollment: Pick<BurrowEnrollment, 'relayUrl' | 'burrowToken'>;
  /** Injectable for tests. */
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  /** Leads the non-2xx message, which always ends in ` (<status>)`. */
  readonly errorPrefix?: string;
}

/**
 * `GET route`, or — the moment a `body` is passed — `POST route` with that body
 * as JSON, authenticated as this Burrow, answered whatever its status. An
 * endpoint whose only input is the bearer still posts, with `{}`.
 */
function burrowRequest(options: BurrowFetchOptions, route: string, body?: unknown): Promise<Response> {
  const doFetch = options.fetch ?? globalThis.fetch;
  return doFetch(`${options.enrollment.relayUrl}${route}`, {
    ...(body === undefined ? {} : { method: 'POST', body: JSON.stringify(body) }),
    // The service replaced a webview whose CSP checked every redirect target,
    // and a Node process re-checks nothing. Do not let the Relay's open redirect
    // forward the bearer token — or the notification metadata — to an origin the
    // build was never baked with.
    redirect: 'error',
    signal: AbortSignal.timeout(options.timeoutMs ?? BURROW_REQUEST_TIMEOUT_MS),
    headers: {
      authorization: `Bearer ${options.enrollment.burrowToken}`,
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
  });
}

/**
 * {@link burrowRequest}, throwing on any non-2xx so no caller can swallow one: a
 * send that ignored a 401 from a revoked burrow token would leave the feature
 * permanently broken and silent, which is the failure mode this path is most
 * prone to.
 */
export async function burrowFetch(
  options: BurrowFetchOptions,
  route: string,
  body?: unknown,
): Promise<Response> {
  const response = await burrowRequest(options, route, body);
  if (!response.ok) {
    throw new Error(`${options.errorPrefix ?? `${route} failed`} (${response.status})`);
  }
  return response;
}

/** What a Relay said of this Burrow's token, when it said it stands no more. */
export type BurrowStanding = 'removed' | 'not-entitled';

/**
 * Ask the Relay whether this Burrow's token still stands, through the one
 * Burrow-gated read both Relays serve, `GET /api/push/devices`
 * (`docs/specs/burrow-service.md` -> "Burrow side", relay socket policy): a 401
 * naming the token unknown is `removed`, a 403 `NOT_ENTITLED_ERROR` is
 * `not-entitled`, and any other 2xx, 401, or 403 `null`. **Rejects when no
 * answer came, or any other status did** — a 5xx, a 404 — which proves
 * nothing either way.
 */
export async function probeBurrowStanding(
  options: Omit<BurrowFetchOptions, 'errorPrefix'>,
): Promise<BurrowStanding | null> {
  const response = await burrowRequest(options, API_ROUTES.pushDevices);
  if (response.ok) return null;
  if (response.status !== 401 && response.status !== 403) {
    throw new Error(`${API_ROUTES.pushDevices} answered ${response.status}`);
  }
  const body: unknown = await response.json().catch(() => null);
  const error = body && typeof body === 'object' ? (body as { error?: unknown }).error : undefined;
  if (response.status === 401 && (error === UNAUTHORIZED_ERROR || error === UNKNOWN_BURROW_TOKEN_ERROR)) {
    return 'removed';
  }
  if (response.status === 403 && error === NOT_ENTITLED_ERROR) return 'not-entitled';
  return null;
}

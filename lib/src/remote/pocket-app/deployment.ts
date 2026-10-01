/**
 * Who serves this Pocket, which decides the ICE servers its direct path gathers
 * through (`docs/specs/remote-network.md` -> "Anywhere"): one bundle, served by
 * Hosted and by every self-host Relay. **Hosted's relay staging writes
 * `POCKET_DEPLOYMENT_FILE`** (`remote-lib-common`), and nothing else does — a self-host Relay
 * answers that path with its shell or a 404 — so no policy crosses the wire and
 * any other complete answer reads as self-host, which gathers through no ICE
 * server. A read that does not complete answers nothing, so Hosted's Pocket
 * never gathers through no ICE server because its own origin was slow.
 */

import { HOSTED_POCKET_DEPLOYMENT, POCKET_DEPLOYMENT_FILE } from 'remote-lib-common';

import type { DirectPeerFactory } from '../direct/direct-peer';
import { hostedDirectPeer, selfHostDirectPeer } from '../client/browser-direct-peer';
import { isRecord } from '../../lib/is-record';

/** Where this page reads the file Hosted stages beside Pocket: its own origin's root. */
export const POCKET_DEPLOYMENT_PATH = `/${POCKET_DEPLOYMENT_FILE}`;

/** How long a Connect or a pairing waits on the deployment read before it fails, retryably. */
export const POCKET_DEPLOYMENT_READ_TIMEOUT_MS = 3_000;

export type PocketDeployment = 'hosted' | 'self-host';

/** The sentence a Connect or a pairing fails with when the deployment read does not complete. */
export function deploymentUnreachableMessage(host: string): string {
  return `Couldn’t reach ${host} to start the connection. Try again.`;
}

/** `hosted` for exactly `HOSTED_POCKET_DEPLOYMENT`'s shape, else `self-host`. */
export function parsePocketDeployment(body: unknown): PocketDeployment {
  return isRecord(body) && body.deployment === HOSTED_POCKET_DEPLOYMENT.deployment ? 'hosted' : 'self-host';
}

/**
 * Who serves this page, read off its own origin within `timeoutMs`. **Null
 * when the read does not complete** — a network failure, the timeout, a 5xx, or
 * a body lost mid-read — since none says who serves it; every complete answer
 * is definite. Never rejects.
 */
export async function readPocketDeployment(
  fetch: typeof globalThis.fetch,
  timeoutMs = POCKET_DEPLOYMENT_READ_TIMEOUT_MS,
): Promise<PocketDeployment | null> {
  const abort = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      abort.abort();
      resolve(null);
    }, timeoutMs);
  });
  const read = (async (): Promise<PocketDeployment | null> => {
    try {
      const response = await fetch(POCKET_DEPLOYMENT_PATH, { cache: 'no-store', signal: abort.signal });
      if (response.status >= 500) return null;
      const text = await response.text();
      if (!response.ok) return 'self-host';
      try {
        return parsePocketDeployment(JSON.parse(text));
      } catch {
        return 'self-host';
      }
    } catch {
      return null;
    }
  })();
  try {
    return await Promise.race([read, timedOut]);
  } finally {
    clearTimeout(timer);
  }
}

/** This page's deployment, cached once a read answers definitely. */
export interface PocketDeploymentSource {
  /** The definite answer, or null until one arrives. */
  readonly known: PocketDeployment | null;
  /**
   * The definite answer, reading it if none is cached; concurrent callers
   * share one read. **Rejects with {@link deploymentUnreachableMessage}** when
   * the read does not complete, caching nothing, so the next call reads again.
   */
  require(): Promise<PocketDeployment>;
}

export function pocketDeploymentSource(
  fetch: typeof globalThis.fetch,
  host: string,
  timeoutMs = POCKET_DEPLOYMENT_READ_TIMEOUT_MS,
): PocketDeploymentSource {
  let known: PocketDeployment | null = null;
  let inFlight: Promise<PocketDeployment> | null = null;
  return {
    get known() {
      return known;
    },
    require() {
      if (known !== null) return Promise.resolve(known);
      inFlight ??= readPocketDeployment(fetch, timeoutMs)
        .then((which) => {
          if (which === null) throw new Error(deploymentUnreachableMessage(host));
          known = which;
          return which;
        })
        .finally(() => {
          inFlight = null;
        });
      return inFlight;
    },
  };
}

/**
 * Pocket's direct-peer factory: the one `source`'s answer names. **Builds no
 * peer before the answer is known**; App awaits
 * {@link PocketDeploymentSource.require} before every Connect and pairing, so
 * the null here is a guard.
 */
export function deploymentDirectPeer(source: Pick<PocketDeploymentSource, 'known'>): DirectPeerFactory {
  return (pathPolicy) => {
    const which = source.known;
    if (which === null) return null;
    return which === 'hosted' ? hostedDirectPeer(pathPolicy) : selfHostDirectPeer(pathPolicy);
  };
}

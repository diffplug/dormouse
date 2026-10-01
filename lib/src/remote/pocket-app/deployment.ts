/**
 * Who serves this Pocket, which decides the ICE servers its direct path gathers
 * through (`docs/specs/remote-network.md` -> "Anywhere"): one bundle, served by
 * Hosted and by every self-host Relay. **Hosted's relay staging writes
 * `POCKET_DEPLOYMENT_FILE`** (`remote-lib-common`), and nothing else does — a self-host Relay
 * answers that path with its shell or a 404 — so no policy crosses the wire and
 * anything but Hosted's exact answer reads as self-host, which gathers through
 * no ICE server.
 */

import { HOSTED_POCKET_DEPLOYMENT, POCKET_DEPLOYMENT_FILE } from 'remote-lib-common';

import type { DirectPeerFactory } from '../direct/direct-peer';
import { hostedDirectPeer, selfHostDirectPeer } from '../client/browser-direct-peer';
import { isRecord } from '../../lib/is-record';

/** Where this page reads the file Hosted stages beside Pocket: its own origin's root. */
export const POCKET_DEPLOYMENT_PATH = `/${POCKET_DEPLOYMENT_FILE}`;

export type PocketDeployment = 'hosted' | 'self-host';

/** `hosted` for exactly `HOSTED_POCKET_DEPLOYMENT`'s shape, else `self-host`. */
export function parsePocketDeployment(body: unknown): PocketDeployment {
  return isRecord(body) && body.deployment === HOSTED_POCKET_DEPLOYMENT.deployment ? 'hosted' : 'self-host';
}

/** Who serves this page, read off its own origin; **never rejects** — a failure is `self-host`. */
export async function readPocketDeployment(
  fetch: typeof globalThis.fetch,
): Promise<PocketDeployment> {
  try {
    const response = await fetch(POCKET_DEPLOYMENT_PATH, { cache: 'no-store' });
    if (!response.ok) return 'self-host';
    return parsePocketDeployment(JSON.parse(await response.text()));
  } catch {
    return 'self-host';
  }
}

/**
 * Pocket's direct-peer factory: {@link selfHostDirectPeer} until `deployment`
 * settles, then the one it names. A connect only follows a sign-in, by which
 * time the read has long settled; one that has not gathers through nothing.
 */
export function deploymentDirectPeer(deployment: Promise<PocketDeployment>): DirectPeerFactory {
  let factory: DirectPeerFactory = selfHostDirectPeer;
  void deployment.then((which) => {
    factory = which === 'hosted' ? hostedDirectPeer : selfHostDirectPeer;
  });
  return (pathPolicy) => factory(pathPolicy);
}

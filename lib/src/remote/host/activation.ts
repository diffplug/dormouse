/**
 * Activation glue: wires this webview to the remote Host service behind the
 * platform adapter, and exposes a `window.dormouseRemoteHost` console hook for
 * enrolling in the POC (no settings UI needed).
 *
 * The Host itself is a service in the process that owns the PTYs
 * (`lib/src/host/remote/service.ts`) — the Tauri sidecar, the VS Code extension
 * host. This module is its client: it forwards console commands, mirrors the
 * pairing queue, and reports rings. It starts no Host, holds no relay socket,
 * and reads no ACL. A host with no service behind it (the website) gets nothing
 * at all, which is why every entry point here tolerates a missing link.
 *
 * Enroll from the devtools console:
 *
 *   await window.dormouseRemoteHost.enroll('https://your-server', 'SETUP_PASSWORD', 'My Laptop')
 *   window.dormouseRemoteHost.status()
 *   window.dormouseRemoteHost.reconnect()      // needed after `displaced`
 *   window.dormouseRemoteHost.clearEnrollment()
 */

import type {
  PairingQueueEvent,
  PairingQueueItem,
  PushDevicesResult,
  RemoteHostConsoleStatus,
} from '../../host/remote/service-protocol';
import { getPlatform } from '../../lib/platform';
import type { RemoteHostLink } from '../../lib/platform/types';
import { setPushDevicesRefresher } from '../../lib/push-devices';
import { clearAclRecords, loadAclRecords } from './acl';
import { commitPushDevices, watchPushRings } from './alert-push';
import { clearEnrollment, getEnrollment } from './enrollment';
import {
  enqueuePairingApproval,
  getPairingApprovalSnapshot,
  resolvePairingApproval,
} from './pairing-approval';

export type { RemoteHostConsoleStatus };

/** Install the `window.dormouseRemoteHost` console hook and connect. Idempotent. */
export function installRemoteHostConsoleHook(): void {
  const link = getPlatform().remoteHost;
  // No service behind this host (the website): there is no Host to reach, and
  // nothing here degrades to a webview-resident one.
  if (link) installBridgeMode(link);
}

// --- Bridge mode: the Host lives in another process ---

let bridgeInstalled = false;

/**
 * Wire this webview to the Host service behind the adapter. No `RemoteHost`, no
 * `RemoteApiSession`, no relay socket: those are the service's, and everything
 * here is either UI or something only a webview knows.
 *
 * Idempotent — `RemotePairingModalHost` mounts twice under StrictMode.
 */
function installBridgeMode(link: RemoteHostLink): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;

  // The service is authoritative about the queue, so a pushed snapshot replaces
  // the mirror wholesale rather than merging into it. Subscribed before the
  // adoption round trip so a pairing that arrives during it is not missed.
  link.on('pairing-queue', (data) => {
    mirrorPairingQueue(link, (data as PairingQueueEvent).queue);
  });

  void adoptWebviewHost(link).then(() => {
    // Seed once: a webview that reloads mid-pairing has an empty mirror and no
    // event coming, since the service only pushes on change.
    void link
      .command('pairingQueue')
      .then((queue) => mirrorPairingQueue(link, (queue ?? []) as PairingQueueItem[]))
      .catch(() => {});
  });

  // Rings are detected here — the activity store and the pane labels are
  // webview state — and delivered there, where the ACL is.
  watchPushRings((sessionId, title) => {
    void link.command('push', { sessionId, title }).catch(() => {});
  });

  const refresh = (): void => {
    void commitPushDevices(async () => {
      const result = (await link.command('pushDevices')) as PushDevicesResult;
      return result ? result.devices : null;
    });
  };
  setPushDevicesRefresher(refresh);
  refresh();

  const target = globalThis as unknown as { dormouseRemoteHost?: unknown };
  if (target.dormouseRemoteHost) return;
  // Same method names and result shapes as the legacy hook (SELF_HOST.md), one
  // round trip further away — so `status()` and `reconnect()` are promises here.
  target.dormouseRemoteHost = {
    enroll: (serverUrl: string, password: string, label: string) =>
      link.command('enroll', { serverUrl, password, label }),
    status: () => link.command('status'),
    reconnect: () => link.command('reconnect'),
    clearEnrollment: () => link.command('clearEnrollment'),
  };
}

/**
 * Hand a Host this webview persisted before the service existed over to it,
 * once. The service keeps whichever enrollment it already has, so this can only
 * add; either way the webview's copy is obsolete afterwards and is cleared —
 * leaving it would be a second ACL for the same hostId, diverging from the
 * moment the next device pairs.
 */
async function adoptWebviewHost(link: RemoteHostLink): Promise<void> {
  const enrollment = getEnrollment();
  if (!enrollment) return;
  try {
    await link.command('adopt', {
      enrollment,
      aclRecords: loadAclRecords(enrollment.hostId),
    });
  } catch (error) {
    // Keep the local copy for the next launch rather than dropping a Host on
    // the floor because one command failed.
    console.warn('remote-host: could not hand the persisted Host to the service', error);
    return;
  }
  clearEnrollment();
  clearAclRecords(enrollment.hostId);
}

/** Project the service's queue onto the modal's store. */
function mirrorPairingQueue(link: RemoteHostLink, queue: readonly PairingQueueItem[]): void {
  const present = new Set(queue.map((item) => item.clientId));
  for (const pending of getPairingApprovalSnapshot()) {
    if (!present.has(pending.clientId)) resolvePairingApproval(pending.clientId);
  }
  const mirrored = new Set(getPairingApprovalSnapshot().map((pending) => pending.clientId));
  for (const item of queue) {
    // Re-enqueuing an unchanged request would reorder the queue and re-render
    // the modal for nothing; the approve/deny closures only need the clientId.
    if (mirrored.has(item.clientId)) continue;
    enqueuePairingApproval({
      clientId: item.clientId,
      request: item.request,
      requestedAt: item.requestedAt,
      approve: (label) => void link.command('approve', { clientId: item.clientId, label }).catch(() => {}),
      deny: () => void link.command('deny', { clientId: item.clientId }).catch(() => {}),
    });
  }
}

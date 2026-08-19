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

import type { PairingRequest } from 'server-lib-common';
import type {
  AdoptResult,
  PairingQueueEvent,
  PairingQueueItem,
  PushDevicesResult,
  RemoteHostConsoleStatus,
} from '../../host/remote/service-protocol';
import { getPlatform } from '../../lib/platform';
import type { RemoteHostLink } from '../../lib/platform/types';
import { clearPushDevices, setPushDevicesRefresher } from '../../lib/push-devices';
import { clearAclRecords, loadAclRecords } from './acl';
import { commitPushDevices, invalidatePushDeviceRefreshes, watchPushRings } from './alert-push';
import { clearEnrollment, getEnrollment } from './enrollment';
import { armWhileEnrolled } from './enrolled-gate';
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

  void adoptWebviewHost(link);

  const refresh = (): void => {
    void commitPushDevices(async () => {
      const result = (await link.command('pushDevices')) as PushDevicesResult;
      return result ? result.devices : null;
    });
  };
  // Installed unconditionally: the dialog may open on an un-enrolled machine,
  // and asking then is one command that answers `no-host`.
  setPushDevicesRefresher(refresh);

  armWhileEnrolled(link, () => {
    // Rings are detected here — the activity store and the pane labels are
    // webview state — and delivered there, where the ACL is.
    const stopRings = watchPushRings((sessionId, title) => {
      void link.command('push', { sessionId, title }).catch(() => {});
    });
    refresh();
    // Seeded on every transition to enrolled, not once at install: the service
    // pushes the queue only when it changes, so a webview that joins — or a
    // machine that enrolls — mid-pairing would otherwise show no modal at all
    // until the next change.
    void link
      .command('pairingQueue')
      .then((queue) => mirrorPairingQueue(link, (queue ?? []) as PairingQueueItem[]))
      .catch(() => {});
    return () => {
      stopRings();
      // The Host is gone, so the dialog must stop naming devices nothing can
      // reach — including any list still on the wire, which would otherwise put
      // them back the moment it lands. The refresher stays installed: the dialog
      // may still open on an un-enrolled machine, where asking is one command
      // that answers `no-host`.
      invalidatePushDeviceRefreshes();
      clearPushDevices();
    };
  });

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
 * add.
 *
 * The copy is cleared only once the service reports it is holding the Host
 * somewhere that survives a restart — leaving it otherwise would be a second
 * ACL for the same hostId, diverging from the moment the next device pairs, but
 * clearing it against an in-memory store (a dev harness with no state
 * directory) would throw the only surviving copy away.
 */
async function adoptWebviewHost(link: RemoteHostLink): Promise<void> {
  const enrollment = getEnrollment();
  if (!enrollment) return;
  let result: AdoptResult | null;
  try {
    result = (await link.command('adopt', {
      enrollment,
      aclRecords: loadAclRecords(enrollment.hostId),
    })) as AdoptResult | null;
  } catch (error) {
    // Keep the local copy for the next launch rather than dropping a Host on
    // the floor because one command failed.
    console.warn('remote-host: could not hand the persisted Host to the service', error);
    return;
  }
  if (!result?.persisted) return;
  clearEnrollment();
  clearAclRecords(enrollment.hostId);
}

/** Project the service's queue onto the modal's store. */
function mirrorPairingQueue(link: RemoteHostLink, queue: readonly PairingQueueItem[]): void {
  const present = new Set(queue.map((item) => item.clientId));
  for (const pending of getPairingApprovalSnapshot()) {
    if (!present.has(pending.clientId)) resolvePairingApproval(pending.clientId);
  }
  const mirrored = new Map(getPairingApprovalSnapshot().map((pending) => [pending.clientId, pending]));
  for (const item of queue) {
    const showing = mirrored.get(item.clientId);
    // Re-enqueuing an unchanged request would reorder the queue and re-render
    // the modal for nothing; the approve/deny closures only need the clientId.
    if (showing && showing.requestedAt === item.requestedAt && sameRequest(showing.request, item.request)) {
      continue;
    }
    // Changed under the same id. The service coalesces a re-sent pair by
    // replacing what it holds for that clientId, so approving authorizes the
    // *new* device — and the modal must therefore be showing the new device.
    // Anything else approves something the user was never shown
    // (docs/specs/remote-security-model.md).
    if (showing) resolvePairingApproval(item.clientId);
    enqueuePairingApproval({
      clientId: item.clientId,
      request: item.request,
      requestedAt: item.requestedAt,
      approve: (label) => void link.command('approve', { clientId: item.clientId, label }).catch(() => {}),
      deny: () => void link.command('deny', { clientId: item.clientId }).catch(() => {}),
    });
  }
}

/**
 * Whether the mirror already shows exactly this request. Field by field rather
 * than by identity: every snapshot arrives as fresh JSON off the bridge, so
 * identity always differs and would re-render the modal on every event.
 */
function sameRequest(a: PairingRequest, b: PairingRequest): boolean {
  return (
    a.accountId === b.accountId &&
    a.passkeyCredentialId === b.passkeyCredentialId &&
    a.passkeyPublicKeyHash === b.passkeyPublicKeyHash &&
    a.devicePublicKey === b.devicePublicKey &&
    a.requestedLabel === b.requestedLabel
  );
}

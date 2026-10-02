/**
 * Activation glue: wires this webview to the Burrow service behind the
 * platform adapter, and exposes a `window.dormouseBurrow` console hook for
 * enrollment scripting alongside the Settings UI.
 *
 * The Burrow itself is a service in the process that owns the PTYs
 * (`lib/src/host/remote/service.ts`) — the Tauri sidecar, the VS Code extension
 * host. This module is its client: it forwards console commands, mirrors the
 * pairing queue, and refreshes the push device list. It starts no Burrow, holds
 * no relay socket, and reads no ACL. A host with no service behind it (the
 * website) gets nothing at all, which is why every entry point here tolerates a
 * missing link.
 *
 * Enroll from the devtools console:
 *
 *   await window.dormouseBurrow.enroll('SETUP_PASSWORD', 'My Laptop')   // at the build's relay origin
 *   await window.dormouseBurrow.enrollOffer('My Laptop')                 // installer's offer, this machine
 *   await window.dormouseBurrow.beginHostedEnrollment('My Laptop')       // a Hosted build: the code to approve
 *   await window.dormouseBurrow.cancelHostedEnrollment()
 *   window.dormouseBurrow.status()
 *   window.dormouseBurrow.reconnect()      // needed after `displaced`, `removed`, or `not-entitled`
 *   window.dormouseBurrow.clearEnrollment()
 */

import {
  approvalKind,
  type PairingQueueEvent,
  type PairingQueueItem,
  type PushDevicesResult,
  type BurrowConsoleStatus,
} from '../../host/remote/service-protocol';
import { getPlatform } from '../../lib/platform';
import type { BurrowLink } from '../../lib/platform/types';
import { clearPushDevices, commitPushDevices, setPushDevicesRefresher } from '../../lib/push-devices';
import { armWhile } from './enrolled-gate';
import {
  enqueuePairingApproval,
  getPairingApprovalSnapshot,
  resolvePairingApproval,
  sameRequest,
} from './pairing-approval';

export type { BurrowConsoleStatus };

/** Install the `window.dormouseBurrow` console hook and connect. Idempotent. */
export function installBurrowConsoleHook(): void {
  const link = getPlatform().burrow;
  // No service behind this host (the website): there is no Burrow to reach, and
  // nothing here degrades to a webview-resident one.
  if (link) installBridgeMode(link);
}

// --- Bridge mode: the Burrow lives in another process ---

let bridgeInstalled = false;

/**
 * Wire this webview to the Burrow service behind the adapter. No `BurrowRuntime`, no
 * `RemoteApiSession`, no relay socket: those are the service's, and everything
 * here is either UI or something only a webview knows.
 *
 * Idempotent — `RemotePairingModalHost` mounts twice under StrictMode.
 */
function installBridgeMode(link: BurrowLink): void {
  if (bridgeInstalled) return;
  bridgeInstalled = true;

  // The service is authoritative about the queue, so a pushed snapshot replaces
  // the mirror wholesale rather than merging into it. Subscribed before the
  // adoption round trip so a pairing that arrives during it is not missed.
  link.on('pairing-queue', (data) => {
    mirrorPairingQueue(link, (data as PairingQueueEvent).queue);
  });

  const refresh = (): void => {
    void commitPushDevices(async () => {
      const result = (await link.command('pushDevices')) as PushDevicesResult;
      return result ? result.devices : null;
    });
  };
  // Installed unconditionally: the dialog may open on an un-enrolled machine,
  // and asking then is one command that answers `no-burrow`.
  setPushDevicesRefresher(refresh);

  armWhile(link, {
    // The device list is the Relay's, so it is armed on the enrollment alone.
    enrolled: () => {
      refresh();
      return () => {
        // The Burrow is gone, so the dialog must stop naming devices nothing can
        // reach — including any list still on the wire, which would otherwise put
        // them back the moment it lands. The refresher stays installed: the dialog
        // may still open on an un-enrolled machine, where asking is one command
        // that answers `no-burrow`.
        clearPushDevices();
      };
    },
    // The queue carries a one-time request too, which needs no enrollment.
    serving: () => {
      // Seeded on every transition to serving, not once at install: the service
      // pushes the queue only when it changes, so a webview that joins — or a
      // machine that enrolls — mid-pairing would otherwise show no modal at all
      // until the next change.
      void link
        .command('pairingQueue')
        .then((queue) => mirrorPairingQueue(link, (queue ?? []) as PairingQueueItem[]))
        .catch(() => {});
      return () => {};
    },
  });

  const target = globalThis as unknown as { dormouseBurrow?: unknown };
  if (target.dormouseBurrow) return;
  // Same method names and result shapes as the legacy hook (docs/specs/relay.md
  // → "Running it"), one round trip further away — so `status()` and
  // `reconnect()` are promises here.
  target.dormouseBurrow = {
    // No Relay argument, and no token: the only Relay is the build's baked
    // origin (`docs/specs/burrow-service.md` → "Relay origin"), and the service reads the
    // installer's token off its file.
    enroll: (password: string, label: string) => link.command('enroll', { password, label }),
    enrollOffer: (label: string) => link.command('enrollOffer', { label }),
    // The service polls the approval; `status()` reports it. Answers the code
    // already waiting, as the panel's Enroll does.
    beginHostedEnrollment: (label: string) => link.command('beginHostedEnrollment', { label }),
    cancelHostedEnrollment: () => link.command('cancelHostedEnrollment'),
    status: () => link.command('status'),
    reconnect: () => link.command('reconnect'),
    clearEnrollment: () => link.command('clearEnrollment'),
  };
}

/**
 * Project the service's queue onto the modal's store, each request named by
 * `(kind, clientId)`. **An item that names no kind is a pairing** — a broker
 * older than the field sends none, and nothing it sends can be a one-time
 * request (`service-protocol.ts` → `ApprovalKind`).
 */
function mirrorPairingQueue(link: BurrowLink, raw: readonly PairingQueueItem[]): void {
  const queue = raw.map((item) => ({ ...item, kind: approvalKind(item) }));
  for (const pending of getPairingApprovalSnapshot()) {
    if (!queue.some((item) => sameRequest(item, pending))) resolvePairingApproval(pending);
  }
  const mirrored = getPairingApprovalSnapshot();
  for (const item of queue) {
    const showing = mirrored.find((pending) => sameRequest(pending, item));
    // Re-enqueuing an unchanged request would reorder the queue and re-render
    // the modal for nothing. The ticket id is part of "unchanged": timestamps
    // can collide, and each approve/deny must echo the exact ticket displayed.
    if (
      showing &&
      showing.pairingId === item.pairingId &&
      showing.requestedAt === item.requestedAt &&
      showing.label === item.label
    ) {
      continue;
    }
    // Changed under the same id. A re-sent pairing replaces its predecessor on
    // the Burrow, so confirming authorizes the *new* device — and the modal must
    // therefore be showing the new device, with the digits typed against the
    // old one discarded (docs/specs/remote-security-model.md).
    if (showing) resolvePairingApproval(item);
    // Every answer echoes the kind, so the service routes it to the half that
    // holds this request.
    const ticket = { kind: item.kind, clientId: item.clientId, pairingId: item.pairingId };
    enqueuePairingApproval({
      ...ticket,
      label: item.label,
      requestedAt: item.requestedAt,
      approve: (code) => void link.command('approve', { ...ticket, code }).catch(() => {}),
      deny: () => void link.command('deny', ticket).catch(() => {}),
    });
  }
}

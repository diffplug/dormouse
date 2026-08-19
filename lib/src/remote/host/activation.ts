/**
 * Activation glue: brings up the remote Host from the persisted enrollment on
 * app start, and exposes a `window.dormouseRemoteHost` console hook for
 * enrolling in the POC (no settings UI needed).
 *
 * There are two worlds here, chosen by whether the platform adapter has a
 * {@link RemoteHostLink}:
 *
 *   - **Bridge mode** (standalone): the Host is a service in the process that
 *     owns the PTYs (`lib/src/host/remote/service.ts`). This module is then a
 *     client of it — it forwards console commands, mirrors the pairing queue,
 *     and reports rings — and starts no Host of its own.
 *   - **Legacy mode** (VS Code, the website): the Host runs in this webview,
 *     and this is the one module that binds the DOM-free controller and
 *     remote-api session to the terminal bridge — the xterm registry, the
 *     platform adapter, and `document` all enter through the surface provider
 *     built below.
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
import { resetPushDevices, setPushDevicesRefresher } from '../../lib/push-devices';
import { subscribeToActivity } from '../../lib/session-activity-store';
import { subscribeToTerminalPaneState } from '../../lib/terminal-state-store';
import { clearAclRecords, loadAclRecords } from './acl';
import {
  commitPushDevices,
  refreshPushDevices,
  startAlertPush,
  watchPushRings,
  type AlertPushDeps,
} from './alert-push';
import { collectDirectorySnapshot } from './directory-collect';
import { clearEnrollment, enrollHost, getEnrollment, type HostEnrollment } from './enrollment';
import type { HostSurfaceProvider } from './host-surface-provider';
import {
  enqueuePairingApproval,
  getPairingApprovalSnapshot,
  resolvePairingApproval,
} from './pairing-approval';
import { peerDirectory } from './peer-surfaces';
import { RemoteApiSession } from './remote-api';
import { RemoteHost } from './remote-host';
import { resolveSurface } from './surface-resolve';

export type { RemoteHostConsoleStatus };

let current: RemoteHost | null = null;
let stopPush: (() => void) | null = null;
let leaseClaimRequested = false;

/**
 * Whether this app instance is the one allowed to be the Host.
 *
 * Standalone is a single webview per app, so it owns the role outright and this
 * stays `true`. VS Code can show several Dormouse webviews at once (a
 * `WebviewView` plus any number of `WebviewPanel`s), and each would otherwise
 * start its own `RemoteHost` against the same enrollment — they would fight
 * over the single `/ws/host` socket (the server displaces the previous holder,
 * see `server/test/relay-displaced.test.mjs`) and each would arm its own alarm
 * push. So a host that can have more than one webview hands out a lease
 * instead, and only the holder activates.
 */
let owned = true;

/**
 * The webview-resident answer to "where do the surfaces live": this webview's
 * xterm registry, plus whatever its peers own
 * (`host-surface-provider.ts`, docs/specs/vscode.md → "Peer surfaces").
 *
 * Assembled here rather than in a module of its own because it is exactly the
 * part that a Node-resident Host replaces: the seam is the durable thing, this
 * binding of it is not.
 */
export function createWebviewSurfaceProvider(): HostSurfaceProvider {
  return {
    async collectDirectory() {
      // A window's terminals may be spread across several webviews with only
      // this one as the Host, so the rest have to be asked; a host with no
      // peers (standalone, the website) answers with nothing. The local panes
      // are read after the round trip, not before, so they are as current as
      // the answers they are merged with.
      const remote = await peerDirectory();
      return [...collectDirectorySnapshot(), ...remote];
    },

    watchDirectory(onChange) {
      const unsubPane = subscribeToTerminalPaneState(onChange);
      const unsubActivity = subscribeToActivity(onChange);
      const unsubPeers = getPlatform().peers?.subscribe('directory', onChange);
      const hasDocument = typeof document !== 'undefined';
      if (hasDocument) {
        document.addEventListener('focusin', onChange);
        document.addEventListener('focusout', onChange);
      }
      return () => {
        unsubPane();
        unsubActivity();
        unsubPeers?.();
        if (hasDocument) {
          document.removeEventListener('focusin', onChange);
          document.removeEventListener('focusout', onChange);
        }
      };
    },

    resolveSurface,

    writePty: (ptyId, data) => getPlatform().writePty(ptyId, data),
    resizePty: (ptyId, cols, rows) => getPlatform().resizePty(ptyId, cols, rows),

    streamPty(ptyId, sink) {
      // The adapter delivers every PTY this webview owns or subscribed to on
      // one stream, so the id filter is the subscription. Pin the adapter the
      // pair was registered on: removing a handler from a different one would
      // leave this attachment streaming forever.
      const platform = getPlatform();
      const onData = (detail: { id: string; data: string }): void => {
        if (detail.id === ptyId) sink.onData(detail.data);
      };
      const onExit = (detail: { id: string; exitCode: number }): void => {
        if (detail.id === ptyId) sink.onExit(detail.exitCode);
      };
      platform.onPtyData(onData);
      platform.onPtyExit(onExit);
      return () => {
        platform.offPtyData(onData);
        platform.offPtyExit(onExit);
      };
    },
  };
}

function startFromEnrollment(enrollment: HostEnrollment): RemoteHost {
  const host = new RemoteHost({
    enrollment,
    createSession: (opts) =>
      new RemoteApiSession({
        hostId: opts.hostId,
        // The controller sends the untyped remote-api payload inside a `msg`.
        send: opts.send,
        provider: createWebviewSurfaceProvider(),
      }),
  });
  host.start();

  // Alarm push is armed here rather than in `Wall` so it exists exactly when a
  // Host does: a build with no enrollment has nothing to push to, and this
  // module is already the lazily-loaded standalone-only boundary
  // (`docs/specs/alert.md` -> Push notifications).
  const deps: AlertPushDeps = {
    enrollment,
    activeRecords: () => host.activeRecords,
  };
  stopPush = startAlertPush(deps);
  // Populate the Alarm settings dialog's device line up front, and let the
  // dialog ask for a fresh one when it opens — a phone can subscribe long after
  // the Host booted, and a list only read at startup would name it never.
  setPushDevicesRefresher(() => void refreshPushDevices(deps));
  void refreshPushDevices(deps);

  return host;
}

/**
 * Grant or revoke this instance's claim to being the Host, starting or stopping
 * it to match. Called by the platform's singleton lease; hosts without one stay
 * granted from the start.
 */
export function setRemoteHostOwnership(next: boolean): void {
  if (owned === next) return;
  owned = next;
  if (owned) activateRemoteHost();
  else stopRemoteHost();
}

/**
 * Start the Host if an enrollment exists, this instance holds the lease, and
 * none is running. Idempotent.
 */
export function activateRemoteHost(): void {
  if (current || !owned) return;
  const enrollment = getEnrollment();
  if (!enrollment) return;
  current = startFromEnrollment(enrollment);
}

export function stopRemoteHost(): void {
  current?.stop();
  current = null;
  stopPush?.();
  stopPush = null;
  // Back to `no-host`: the dialog must stop naming devices nothing can reach.
  resetPushDevices();
}

function remoteHostStatus(): RemoteHostConsoleStatus {
  const enrollment = getEnrollment();
  return {
    enrolled: !!enrollment,
    serverUrl: enrollment?.serverUrl ?? null,
    hostId: enrollment?.hostId ?? null,
    connection: current?.status ?? 'stopped',
    pairedClients: current?.activeRecords.length ?? 0,
  };
}

/** Install the `window.dormouseRemoteHost` console hook and activate. Idempotent. */
export function installRemoteHostConsoleHook(): void {
  const link = getPlatform().remoteHost;
  if (link) {
    installBridgeMode(link);
    return;
  }

  // A host that can show several webviews arbitrates which one is the Host —
  // having peers at all is exactly the condition that needs arbitrating, which
  // is why one member answers both. Start un-owned so two webviews racing to
  // mount cannot both activate before the first lease answer arrives, and let
  // the grant do the activating.
  const peers = getPlatform().peers;
  if (peers) {
    owned = false;
    if (getEnrollment()) {
      leaseClaimRequested = true;
      peers.claimSingleton('remote-host', setRemoteHostOwnership);
    }
  } else {
    activateRemoteHost();
  }
  const target = globalThis as unknown as { dormouseRemoteHost?: unknown };
  if (target.dormouseRemoteHost) return;
  target.dormouseRemoteHost = {
    async enroll(serverUrl: string, password: string, label: string) {
      const enrollment = await enrollHost(serverUrl, password, label);
      stopRemoteHost();
      if (peers && !leaseClaimRequested) {
        leaseClaimRequested = true;
        peers.claimSingleton('remote-host', setRemoteHostOwnership);
      }
      // A synchronous grant may already have activated from persisted storage.
      if (owned && !current) current = startFromEnrollment(enrollment);
      return { hostId: enrollment.hostId, serverUrl: enrollment.serverUrl };
    },
    status: remoteHostStatus,
    /**
     * Re-open the relay socket now. The only way back from `displaced`: an
     * evicted Host stands down for good rather than fighting the Host that
     * replaced it, so returning has to be asked for.
     */
    reconnect(): RemoteHostConsoleStatus {
      activateRemoteHost();
      current?.start();
      return remoteHostStatus();
    },
    clearEnrollment() {
      stopRemoteHost();
      clearEnrollment();
    },
  };
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

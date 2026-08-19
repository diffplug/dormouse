/**
 * Activation glue: starts a single {@link RemoteHost} from the persisted
 * enrollment on app start, and exposes a `window.dormouseRemoteHost` console
 * hook for enrolling in the POC (no settings UI needed).
 *
 * This is the one module that binds the DOM-free controller and remote-api
 * session to the terminal bridge — the xterm registry, the platform adapter,
 * and `document` all enter through the surface provider built below — so only
 * the running app imports it, and everything it wires stays DOM-free.
 *
 * Enroll from the devtools console:
 *
 *   await window.dormouseRemoteHost.enroll('https://your-server', 'SETUP_PASSWORD', 'My Laptop')
 *   window.dormouseRemoteHost.status()
 *   window.dormouseRemoteHost.reconnect()      // needed after `displaced`
 *   window.dormouseRemoteHost.clearEnrollment()
 */

import { getPlatform } from '../../lib/platform';
import { resetPushDevices, setPushDevicesRefresher } from '../../lib/push-devices';
import { subscribeToActivity } from '../../lib/session-activity-store';
import { subscribeToTerminalPaneState } from '../../lib/terminal-state-store';
import { refreshPushDevices, startAlertPush, type AlertPushDeps } from './alert-push';
import { collectDirectorySnapshot } from './directory-collect';
import { clearEnrollment, enrollHost, getEnrollment, type HostEnrollment } from './enrollment';
import type { HostSurfaceProvider } from './host-surface-provider';
import { peerDirectory } from './peer-surfaces';
import { RemoteApiSession } from './remote-api';
import { RemoteHost, type RemoteHostStatus } from './remote-host';
import { resolveSurface } from './surface-resolve';

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

export interface RemoteHostConsoleStatus {
  enrolled: boolean;
  serverUrl: string | null;
  hostId: string | null;
  /**
   * The relay socket's state. `displaced` is the one that needs acting on:
   * another Dormouse instance enrolled with the same `hostId` took the relay
   * slot, so this one stood down and no timer will bring it back — `reconnect()`
   * takes the slot back (and displaces the other one in turn).
   */
  connection: RemoteHostStatus;
  pairedClients: number;
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

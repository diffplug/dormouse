/**
 * Activation glue: starts a single {@link RemoteHost} from the persisted
 * enrollment on app start, and exposes a `window.dormouseRemoteHost` console
 * hook for enrolling in the POC (no settings UI needed).
 *
 * This is the one module that binds the DOM-free controller to the terminal
 * bridge (`RemoteApiSession` touches xterm / the platform adapter), so only the
 * running app imports it — the controller and its tests stay DOM-free.
 *
 * Enroll from the devtools console:
 *
 *   await window.dormouseRemoteHost.enroll('https://your-server', 'SETUP_PASSWORD', 'My Laptop')
 *   window.dormouseRemoteHost.status()
 *   window.dormouseRemoteHost.clearEnrollment()
 */

import { getPlatform } from '../../lib/platform';
import { resetPushDevices, setPushDevicesRefresher } from '../../lib/push-devices';
import { refreshPushDevices, startAlertPush, type AlertPushDeps } from './alert-push';
import { clearEnrollment, enrollHost, getEnrollment, type HostEnrollment } from './enrollment';
import { RemoteApiSession } from './remote-api';
import { RemoteHost } from './remote-host';

let current: RemoteHost | null = null;
let stopPush: (() => void) | null = null;

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

function startFromEnrollment(enrollment: HostEnrollment): RemoteHost {
  const host = new RemoteHost({
    enrollment,
    createSession: (opts) =>
      new RemoteApiSession({
        hostId: opts.hostId,
        // The controller sends the untyped remote-api payload inside a `msg`.
        send: opts.send,
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
  connection: string;
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
  // A host that can show several webviews arbitrates which one is the Host.
  // Start un-owned so two webviews racing to mount cannot both activate before
  // the first lease answer arrives.
  const claimSingleton = getPlatform().claimSingleton;
  if (claimSingleton) {
    owned = false;
    claimSingleton('remote-host', setRemoteHostOwnership);
  }
  activateRemoteHost();
  const target = globalThis as unknown as { dormouseRemoteHost?: unknown };
  if (target.dormouseRemoteHost) return;
  target.dormouseRemoteHost = {
    async enroll(serverUrl: string, password: string, label: string) {
      const enrollment = await enrollHost(serverUrl, password, label);
      stopRemoteHost();
      current = startFromEnrollment(enrollment);
      return { hostId: enrollment.hostId, serverUrl: enrollment.serverUrl };
    },
    status: remoteHostStatus,
    clearEnrollment() {
      stopRemoteHost();
      clearEnrollment();
    },
  };
}

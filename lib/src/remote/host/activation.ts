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

import { resetPushDevices, setPushDevicesRefresher } from '../../lib/push-devices';
import { refreshPushDevices, startAlertPush, type AlertPushDeps } from './alert-push';
import { clearEnrollment, enrollHost, getEnrollment, type HostEnrollment } from './enrollment';
import { RemoteApiSession } from './remote-api';
import { RemoteHost } from './remote-host';

let current: RemoteHost | null = null;
let stopPush: (() => void) | null = null;

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

/** Start the Host if an enrollment exists and none is running. Idempotent. */
export function activateRemoteHost(): void {
  if (current) return;
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

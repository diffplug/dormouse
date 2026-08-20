/**
 * The remote-Host status the Settings dialog renders, as an external store.
 *
 * The Host is a service in the process that owns the PTYs, so everything here
 * is one round trip away over the `remoteHost` link (`activation.ts`). This
 * module holds no Host, no relay socket and no ACL — it asks and mirrors.
 *
 * Deliberately independent of `installRemoteHostConsoleHook`: that lives in the
 * lazily-loaded pairing-modal chunk, while Settings is in the main one. Both
 * subscribe to the same service events, and `link.on` supports either arriving
 * first, so the dialog works whether or not the pairing chunk has loaded.
 *
 * The service's `status` event carries only `{ enrolled }`
 * (`service-protocol.ts` -> `HostStatusEvent`), which is enough to know the
 * answer changed but not what it changed to — so every event re-reads the full
 * status rather than patching a field.
 */

import type { RemoteHostConsoleStatus } from '../../host/remote/service-protocol';
import { getPlatform } from '../../lib/platform';
import type { RemoteHostLink } from '../../lib/platform/types';

/**
 * `unsupported` is a build with no Host service behind it (the website, the
 * lib dev server) — not a failure, and the section renders nothing at all.
 * It is distinct from `error`, which means there is a service and it refused.
 */
export type RemoteHostStatusState =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'ready'; status: RemoteHostConsoleStatus }
  | { kind: 'error'; message: string };

const UNSUPPORTED: RemoteHostStatusState = { kind: 'unsupported' };
const LOADING: RemoteHostStatusState = { kind: 'loading' };

let state: RemoteHostStatusState = LOADING;
const listeners = new Set<() => void>();
let unsubscribeFromLink: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * The service's `status` event fires only when `enrolled` changes, because that
 * is the edge its webview gate arms on. The *connection* moves underneath it
 * with no event at all: `connecting -> connected` on a normal start,
 * `connected -> disconnected` on a dropped relay, `-> displaced` when another
 * instance takes the slot. Without a poll the dialog would show whichever state
 * happened to be true the instant it opened — a machine that connected a second
 * later reads as permanently "Connecting…".
 *
 * Polling only while something is subscribed keeps this to the seconds the
 * dialog is actually open, rather than a standing timer on every window.
 */
const POLL_MS = 2000;

/**
 * Guards against a stale answer overwriting a newer one: enroll and disconnect
 * both refresh, and the dialog may refresh on open while one is still in
 * flight. Only the newest read may commit.
 */
let generation = 0;

function setState(next: RemoteHostStatusState): void {
  state = next;
  for (const listener of listeners) listener();
}

/**
 * `getPlatform` throws before `initPlatform`, and a host may simply have no
 * service. Both mean the same thing here: nothing to ask.
 */
function link(): RemoteHostLink | undefined {
  try {
    return getPlatform().remoteHost;
  } catch {
    return undefined;
  }
}

export function getRemoteHostStatusSnapshot(): RemoteHostStatusState {
  return state;
}

export function subscribeToRemoteHostStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const active = link();
    if (active) {
      unsubscribeFromLink = active.on('status', () => void refreshRemoteHostStatus());
      pollTimer = setInterval(() => void refreshRemoteHostStatus(), POLL_MS);
      void refreshRemoteHostStatus();
    } else {
      setState(UNSUPPORTED);
    }
  }
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      unsubscribeFromLink?.();
      unsubscribeFromLink = null;
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = null;
      // Next mount re-reads rather than showing a snapshot from a previous open,
      // which may predate an enrollment made in another window.
      state = LOADING;
      generation++;
    }
  };
}

/** Re-read the service's status. Safe to call concurrently. */
export async function refreshRemoteHostStatus(): Promise<void> {
  const active = link();
  if (!active) {
    setState(UNSUPPORTED);
    return;
  }
  const mine = ++generation;
  try {
    const status = (await active.command('status')) as RemoteHostConsoleStatus | null;
    if (mine !== generation) return;
    setState(status ? { kind: 'ready', status } : UNSUPPORTED);
  } catch (error) {
    if (mine !== generation) return;
    setState({ kind: 'error', message: describeError(error) });
  }
}

/**
 * Enroll this machine with a coordinating server.
 *
 * The password is a bearer credential and is passed straight through to the
 * service, which is what talks to the server; it is never stored here. The
 * service refuses an origin outside this build's baked relay allowlist *before*
 * the password leaves the machine (`docs/specs/server.md`, "Where a Host may
 * reach a relay server"), so a mistyped origin fails closed rather than leaking
 * it. Rejections propagate verbatim — the caller renders them.
 */
export async function enrollRemoteHost(
  serverUrl: string,
  password: string,
  label: string,
): Promise<void> {
  const active = link();
  if (!active) throw new Error('This build has no remote Host service.');
  await active.command('enroll', { serverUrl, password, label });
  await refreshRemoteHostStatus();
}

/**
 * Take the relay slot back after `displaced` — which is terminal by design, so
 * nothing reconnects on its own. This displaces the other instance in turn
 * (`docs/specs/server.md`, "Relay socket policy").
 */
export async function reconnectRemoteHost(): Promise<void> {
  const active = link();
  if (!active) throw new Error('This build has no remote Host service.');
  await active.command('reconnect');
  await refreshRemoteHostStatus();
}

/**
 * Forget the enrollment. The service awaits the delete before reporting
 * un-enrolled, so a failed delete leaves this machine enrolled rather than
 * claiming otherwise while the credential is still on disk.
 */
export async function clearRemoteHostEnrollment(): Promise<void> {
  const active = link();
  if (!active) throw new Error('This build has no remote Host service.');
  await active.command('clearEnrollment');
  await refreshRemoteHostStatus();
}

/**
 * What "Send test push" reports back.
 *
 * `targeted: 0` is the ordinary answer on a freshly enrolled machine — the Host
 * is fine, no phone has enabled alerts yet — so it is a distinct outcome rather
 * than an error. Anything the user could act on differently deserves its own
 * answer, and "no devices" and "the server refused" are not the same problem.
 */
export interface PushTestOutcome {
  targeted: number;
  delivered: number;
  failed: number;
}

/**
 * Ask the Host service to send a test push and report what happened.
 *
 * Rejects when there is no service, no enrollment, or the server refused —
 * unlike the ring path, which swallows everything so a failed push can never
 * break an alarm (`docs/specs/server.md` -> Web Push). A test button is the one
 * caller that needs the failure.
 *
 * Lives here rather than beside the ring watcher in `alert-push.ts`: that
 * module is deliberately inside the lazily-imported `RemotePairingModalHost`
 * chunk, and importing it from the Settings dialog would pull the whole
 * remote-host stack into the main bundle on every host.
 */
export async function sendTestPush(): Promise<PushTestOutcome> {
  const active = link();
  if (!active) throw new Error('This build has no remote Host service.');
  return (await active.command('pushTest')) as PushTestOutcome;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  return 'The Host service did not answer.';
}

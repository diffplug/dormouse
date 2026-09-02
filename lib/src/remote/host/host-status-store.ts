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

import type {
  InvitationEvent,
  PushSendSummary,
  RemoteHostConsoleStatus,
  SetupQrResult,
} from '../../host/remote/service-protocol';
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
let refreshInFlight: Promise<void> | null = null;
let refreshAgain = false;

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
 * dialog is actually open, rather than a standing timer on every window. A
 * slow read is never overlapped: ticks coalesce behind it, so its timeout can
 * commit instead of every later tick making the eventual failure stale.
 */
const POLL_MS = 2000;

/** Invalidates an in-flight answer that can no longer be the one anybody wants. */
let generation = 0;

/**
 * Publish a new state, skipping a write that says the same thing.
 *
 * The poll re-reads every 2 s and the service answers with a fresh object each
 * time, so without this the section re-renders twice a minute to paint
 * identical text. The sibling store this same dialog reads guards the same way
 * (`setPushDevices` in `lib/src/lib/push-devices.ts`); comparing the fields in
 * {@link STATUS_FIELDS} is the whole of it.
 */
function setState(next: RemoteHostStatusState): void {
  if (sameState(state, next)) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * How to tell whether each field of a {@link RemoteHostConsoleStatus} changed —
 * one comparator per field, which is also the compile-time checklist that every
 * field has one.
 *
 * A field added to the interface and forgotten here would be polled but never
 * published, so the section would paint that field from whenever one of the
 * others last changed — stale for as long as the dialog stays open, and nothing
 * else would catch it. The mapped type makes the *omission* a compile error;
 * it cannot make a nested field's comparator right, since `Object.is`
 * type-checks for one of those too. `offer` is compared by its origin because
 * the service mints a fresh object per read, and "compares the offer by its
 * origin, not by the object the poll minted" in `host-status-store.test.ts` is
 * what pins that.
 */
const STATUS_FIELDS: {
  [K in keyof RemoteHostConsoleStatus]: (
    a: RemoteHostConsoleStatus[K],
    b: RemoteHostConsoleStatus[K],
  ) => boolean;
} = {
  enrolled: Object.is,
  serverUrl: Object.is,
  hostId: Object.is,
  connection: Object.is,
  pairedClients: Object.is,
  suggestedLabel: Object.is,
  offer: (a, b) => a?.origin === b?.origin,
};

function sameState(a: RemoteHostStatusState, b: RemoteHostStatusState): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'error' && b.kind === 'error') return a.message === b.message;
  if (a.kind === 'ready' && b.kind === 'ready') {
    const left = a.status;
    const right = b.status;
    return (Object.keys(STATUS_FIELDS) as Array<keyof RemoteHostConsoleStatus>).every((field) => {
      // One cast, because TypeScript cannot correlate the key with its own
      // comparator's parameter types while iterating the map.
      const same = STATUS_FIELDS[field] as (x: unknown, y: unknown) => boolean;
      return same(left[field], right[field]);
    });
  }
  // `unsupported` and `loading` are the two singletons, so matching kinds is all.
  return true;
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
      // which may predate an enrollment made in another window. That includes
      // dropping a read still in flight: keeping it would have the next mount
      // coalesce onto an answer fetched for a dialog that is already closed,
      // and sit on "Checking…" until it finally settles.
      state = LOADING;
      dropInFlightRead();
    }
  };
}

/** Re-read the service's status, coalescing calls while one read is in flight. */
export function refreshRemoteHostStatus(): Promise<void> {
  if (refreshInFlight) {
    refreshAgain = true;
    return refreshInFlight;
  }

  const refresh = readRemoteHostStatus();
  refreshInFlight = refresh;
  void refresh.then(() => {
    if (refreshInFlight !== refresh) return;
    refreshInFlight = null;
    if (refreshAgain && listeners.size > 0) {
      refreshAgain = false;
      void refreshRemoteHostStatus();
    }
  });
  return refresh;
}

/**
 * Stop coalescing onto the read in flight, because its answer is no longer the
 * one anybody is waiting for.
 *
 * Safe to call at any point: the abandoned read is neutralized twice over —
 * `generation` moves, so it cannot commit, and its completion callback sees a
 * different in-flight promise, so it cannot clear whatever replaced it.
 */
function dropInFlightRead(): void {
  refreshInFlight = null;
  refreshAgain = false;
  generation++;
}

/**
 * Re-read *after* a mutation this module just made.
 *
 * Coalescing is right for the poll, where any recent answer will do, and wrong
 * here: a read issued before the enroll/disconnect answers the question as it
 * stood beforehand, so joining it would report the old enrollment as though the
 * command had not run — the inverse of the delete-first ordering the service
 * uses so a failed delete never claims to have succeeded.
 */
function refreshAfterMutation(): Promise<void> {
  dropInFlightRead();
  return refreshRemoteHostStatus();
}

/**
 * The answer as *this* build's shape, whoever answered it.
 *
 * The cast above is a claim about a value from another process, and in VS Code
 * that process may be an older build than the webview asking it: a broker window
 * running the extension from before a field was added answers without it
 * (`docs/specs/vscode.md` → the peer link). `suggestedLabel` reaches
 * `label.trim()` while the enroll form renders, where an `undefined` throws the
 * whole section away rather than degrading, so it is defaulted here — at the
 * seam where the untrusted shape becomes the typed one — instead of at each of
 * the two forms that read it.
 */
function normalizeStatus(status: RemoteHostConsoleStatus): RemoteHostConsoleStatus {
  return { ...status, suggestedLabel: status.suggestedLabel ?? '' };
}

async function readRemoteHostStatus(): Promise<void> {
  const active = link();
  if (!active) {
    setState(UNSUPPORTED);
    return;
  }
  const mine = ++generation;
  try {
    const status = (await active.command('status')) as RemoteHostConsoleStatus | null;
    if (mine !== generation) return;
    setState(status ? { kind: 'ready', status: normalizeStatus(status) } : UNSUPPORTED);
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
  await refreshAfterMutation();
}

/**
 * Enroll against the offer the installer left on this machine — the one-click
 * path, where the only thing the user chooses is what to call the machine
 * (`service-protocol.ts` → `RemoteHostConsoleStatus.offer`).
 *
 * `origin` is the one the card *displayed*, echoed so the service can refuse a
 * file rewritten since — it is not what gets enrolled against, which comes off
 * the file along with the token this realm never sees.
 *
 * Rejections propagate verbatim, including the same allowlist refusal the typed
 * form gets: a server installed on this machine can still be an origin this
 * build was not compiled to reach.
 */
export async function enrollOfferRemoteHost(origin: string, label: string): Promise<void> {
  const active = link();
  if (!active) throw new Error('This build has no remote Host service.');
  await active.command('enrollOffer', { origin, label });
  await refreshAfterMutation();
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
  await refreshAfterMutation();
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
  await refreshAfterMutation();
}

/**
 * Mint the code behind this machine's setup QR (`docs/specs/server.md` → Setup
 * tokens). Unlike everything above it, this changes nothing the status reports,
 * so it does not re-read one.
 *
 * The token rides back inside the URL, which is the point: it exists to be shown
 * to whoever is standing at this machine (`service-protocol.ts` →
 * `SetupQrResult`). Rejections propagate verbatim — a relay that is down and a
 * server that refuses both have to read as themselves.
 */
export async function mintSetupQr(): Promise<SetupQrResult> {
  const active = link();
  if (!active) throw new Error('This build has no remote Host service.');
  return (await active.command('setupQr')) as SetupQrResult;
}

/**
 * Be told when an invitation this machine minted changes state, so the panel
 * still offering *that* code can stop. Independent of the status subscription
 * above: the event changes no status field, so there is nothing to re-read.
 *
 * The listener gets the `inviteId`, the state, and — where a pairing ceremony
 * ended — how it ended; a panel showing a different invitation ignores the
 * first two (`service-protocol.ts` → `InvitationEvent`). An event that names no
 * invitation is dropped here rather than passed on as `undefined` — the service
 * is typed to send one, so the only source of a malformed event is a bridge
 * nobody should be trusting to pick a panel.
 *
 * **Membership is not checked here**, only that the field is a string: the
 * closed set lives in the copy table the panel renders from, and importing it
 * would be a *value* import of `remote-host.ts` from the main chunk — the whole
 * stack this module exists to stay out of. A member this build does not know
 * therefore lands as an outcome nothing has a sentence for, and the panel falls
 * back to what it said before there were outcomes at all.
 */
export function subscribeToInvitation(
  listener: (
    inviteId: string,
    state: InvitationEvent['state'],
    outcome?: InvitationEvent['outcome'],
  ) => void,
): () => void {
  return (
    link()?.on('invitation', (data) => {
      const event = data as InvitationEvent | undefined;
      if (typeof event?.inviteId === 'string' && typeof event.state === 'string') {
        const outcome = typeof event.outcome === 'string' ? event.outcome : undefined;
        listener(event.inviteId, event.state, outcome);
      }
    }) ?? (() => {})
  );
}

/**
 * Ask the Host service to send a test push and report what happened
 * (`PushSendSummary` in `service-protocol.ts` — the same type the service's
 * `pushTest` command answers with, so the two ends cannot drift).
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
export async function sendTestPush(): Promise<PushSendSummary> {
  const active = link();
  if (!active) throw new Error('This build has no remote Host service.');
  return (await active.command('pushTest')) as PushSendSummary;
}

function describeError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  // Completes the section's own sentence — "Could not reach this machine's
  // remote-control service: …" — so it does not name the service again, in the
  // internal word at that (`RemoteControlSection.tsx`).
  return 'It did not answer.';
}

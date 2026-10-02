/**
 * The remote-Burrow status the Settings dialog renders, as an external store.
 *
 * The Burrow is a service in the process that owns the PTYs, so everything here
 * is one round trip away over the `burrow` link (`activation.ts`). This
 * module holds no Burrow, no relay socket and no ACL — it asks and mirrors.
 *
 * Deliberately independent of `installBurrowConsoleHook`: that lives in the
 * lazily-loaded pairing-modal chunk, while Settings is in the main one. Both
 * subscribe to the same service events, and `link.on` supports either arriving
 * first, so the dialog works whether or not the pairing chunk has loaded.
 *
 * The service's `status` event carries only `{ enrolled, serving, serviceId }`
 * (`service-protocol.ts` -> `BurrowStatusEvent`), which is enough to know the
 * answer changed but not what it changed to — so every event re-reads the full
 * status rather than patching a field.
 */

import {
  HOSTED_ENROLLMENT_END_REASONS,
  type HostedEnrollmentState,
  type InvitationEvent,
  type PushSendSummary,
  type BurrowConsoleStatus,
  type SetupQrResult,
} from '../../host/remote/service-protocol';
import { getPlatform } from '../../lib/platform';
import type { BurrowLink } from '../../lib/platform/types';

/**
 * `unsupported` is a build with no Burrow service behind it (the website, the
 * lib dev server) — not a failure, and the section renders nothing at all.
 * It is distinct from `error`, which means there is a service and no read of
 * it has succeeded since the first subscriber came.
 */
export type BurrowStatusState =
  | { kind: 'unsupported' }
  | { kind: 'loading' }
  | { kind: 'ready'; status: BurrowConsoleStatus }
  | { kind: 'error'; message: string };

const UNSUPPORTED: BurrowStatusState = { kind: 'unsupported' };
const LOADING: BurrowStatusState = { kind: 'loading' };

let state: BurrowStatusState = LOADING;
const listeners = new Set<() => void>();
let unsubscribeFromLink: (() => void) | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let refreshInFlight: Promise<void> | null = null;
let refreshAgain = false;

/**
 * The service's `status` event fires only when `enrolled` or `serving` changes —
 * the edges its webview gate arms on — and once as the service starts, to name
 * the instance's `serviceId`. The *connection* moves underneath it
 * with no event at all: `connecting -> connected` on a normal start,
 * `connected -> disconnected` on a dropped relay, `-> displaced` when another
 * instance takes the slot, `-> removed` when the Relay drops this Burrow. Without a poll the dialog would show whichever state
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
 * time, so without this the section re-renders on every poll to paint
 * identical text. The sibling store this same dialog reads guards the same way
 * (`setPushDevices` in `lib/src/lib/push-devices.ts`); comparing the fields in
 * {@link STATUS_FIELDS} is the whole of it.
 */
function setState(next: BurrowStatusState): void {
  if (sameState(state, next)) return;
  state = next;
  for (const listener of listeners) listener();
}

/**
 * How to tell whether each field of a {@link BurrowConsoleStatus} changed —
 * one comparator per field, which is also the compile-time checklist that every
 * field has one.
 *
 * A field added to the interface and forgotten here would be polled but never
 * published, so the section would paint that field from whenever one of the
 * others last changed — stale for as long as the dialog stays open, and nothing
 * else would catch it. The mapped type makes the *omission* a compile error;
 * it cannot make a nested field's comparator right, since `Object.is`
 * type-checks for one of those too.
 */
const STATUS_FIELDS: {
  [K in keyof BurrowConsoleStatus]: (
    a: BurrowConsoleStatus[K],
    b: BurrowConsoleStatus[K],
  ) => boolean;
} = {
  enrolled: Object.is,
  serving: Object.is,
  relayOrigin: Object.is,
  relayMode: Object.is,
  burrowId: Object.is,
  connection: Object.is,
  pairedClients: Object.is,
  suggestedLabel: Object.is,
  offer: Object.is,
  // A fresh object every poll, so field by field: a reference compare would
  // republish every 2 s while a code waits.
  hostedEnrollment: (a, b) => JSON.stringify(a) === JSON.stringify(b),
  accountOrigin: Object.is,
};

function sameState(a: BurrowStatusState, b: BurrowStatusState): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  if (a.kind === 'error' && b.kind === 'error') return a.message === b.message;
  if (a.kind === 'ready' && b.kind === 'ready') {
    const left = a.status;
    const right = b.status;
    return (Object.keys(STATUS_FIELDS) as Array<keyof BurrowConsoleStatus>).every((field) => {
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
export function burrowLink(): BurrowLink | undefined {
  try {
    return getPlatform().burrow;
  } catch {
    return undefined;
  }
}

/** The Burrow link, for a command that has nothing to do without one. */
export function requireBurrowLink(): BurrowLink {
  const active = burrowLink();
  if (!active) throw new Error('This build has no Burrow service.');
  return active;
}

export function getBurrowStatusSnapshot(): BurrowStatusState {
  return state;
}

export function subscribeToBurrowStatus(listener: () => void): () => void {
  listeners.add(listener);
  if (listeners.size === 1) {
    const active = burrowLink();
    if (active) {
      unsubscribeFromLink = active.on('status', () => void refreshBurrowStatus());
      pollTimer = setInterval(() => void refreshBurrowStatus(), POLL_MS);
      void refreshBurrowStatus();
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
export function refreshBurrowStatus(): Promise<void> {
  if (refreshInFlight) {
    refreshAgain = true;
    return refreshInFlight;
  }

  const refresh = readBurrowStatus();
  refreshInFlight = refresh;
  void refresh.then(() => {
    if (refreshInFlight !== refresh) return;
    refreshInFlight = null;
    if (refreshAgain && listeners.size > 0) {
      refreshAgain = false;
      void refreshBurrowStatus();
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
  return refreshBurrowStatus();
}

/**
 * A `hostedEnrollment` as this build can draw it, or `null` for a shape it does
 * not know. Built field by field, in a fixed order, which {@link STATUS_FIELDS}
 * compares on.
 */
function hostedEnrollmentOf(value: unknown): HostedEnrollmentState | null {
  if (!value || typeof value !== 'object') return null;
  const state = value as Record<string, unknown>;
  if (state.status === 'waiting') {
    const { userCode, verificationUrl, expiresAt } = state;
    return typeof userCode === 'string' && typeof verificationUrl === 'string' && typeof expiresAt === 'number'
      ? { status: 'waiting', userCode, verificationUrl, expiresAt, accountFull: state.accountFull === true }
      : null;
  }
  if (state.status === 'redeeming') return { status: 'redeeming' };
  if (state.status !== 'ended') return null;
  const reason = HOSTED_ENROLLMENT_END_REASONS.find((known) => known === state.reason) ?? 'failed';
  return {
    status: 'ended',
    reason,
    ...(typeof state.message === 'string' ? { message: state.message } : {}),
    ...(typeof state.burrowId === 'string' ? { burrowId: state.burrowId } : {}),
  };
}

async function readBurrowStatus(): Promise<void> {
  const active = burrowLink();
  if (!active) {
    setState(UNSUPPORTED);
    return;
  }
  const mine = ++generation;
  try {
    const status = (await active.command('status')) as BurrowConsoleStatus | null;
    if (mine !== generation) return;
    // `hostedEnrollment` is the one field a newer broker in another VS Code
    // window may extend (`docs/specs/vscode.md` → the peer link).
    setState(
      status
        ? { kind: 'ready', status: { ...status, hostedEnrollment: hostedEnrollmentOf(status.hostedEnrollment) } }
        : UNSUPPORTED,
    );
  } catch (error) {
    if (mine !== generation) return;
    // A status already read stands, and the next tick retries: publishing one
    // failed poll as `error` would unmount everything the section holds open
    // on it — a setup code, a half-typed password, the one-time panel.
    if (state.kind === 'ready') return;
    setState({ kind: 'error', message: describeBurrowError(error) });
  }
}

/**
 * Enroll this machine with its build's Relay.
 *
 * The password is a bearer credential and is passed straight through to the
 * service, which is what talks to the Relay; it is never stored here. There is
 * no origin to pass: the service posts only to the build's baked relay origin
 * (`docs/specs/relay.md` → "Relay origin"). Rejections propagate verbatim —
 * the caller renders them.
 */
export async function enrollBurrow(password: string, label: string): Promise<void> {
  const active = requireBurrowLink();
  await active.command('enroll', { password, label });
  await refreshAfterMutation();
}

/**
 * Enroll against the offer the installer left on this machine — the one-click
 * path, where the only thing the user chooses is what to call the machine
 * (`service-protocol.ts` → `BurrowConsoleStatus.offer`). The token comes off
 * the file, which this realm never sees. Rejections propagate verbatim, like
 * the typed form's.
 */
export async function enrollOfferBurrow(label: string): Promise<void> {
  const active = requireBurrowLink();
  await active.command('enrollOffer', { label });
  await refreshAfterMutation();
}

/**
 * Begin a Hosted build's device-code enrollment under `label`; the service
 * polls it and reports through `status` (`HostedEnrollmentState`). A code
 * already waiting is answered, and one that ended is replaced. Rejections
 * propagate verbatim — the caller renders them. Re-reads either way.
 */
export async function beginHostedEnrollment(label: string): Promise<void> {
  const active = requireBurrowLink();
  try {
    await active.command('beginHostedEnrollment', { label });
  } finally {
    await refreshAfterMutation();
  }
}

/** Stop the Hosted enrollment waiting or ended, and re-read. */
export async function cancelHostedEnrollment(): Promise<void> {
  const active = requireBurrowLink();
  await active.command('cancelHostedEnrollment');
  await refreshAfterMutation();
}

/**
 * Re-open the relay socket after a latched state — terminal by design, so
 * nothing reconnects on its own. After `displaced` this displaces the other
 * instance in turn (`docs/specs/relay.md`, "Burrow side", relay socket policy).
 */
export async function reconnectBurrow(): Promise<void> {
  const active = requireBurrowLink();
  await active.command('reconnect');
  await refreshAfterMutation();
}

/**
 * Forget the enrollment. The service awaits the delete before reporting
 * un-enrolled, so a failed delete leaves this machine enrolled rather than
 * claiming otherwise while the credential is still on disk.
 */
export async function clearBurrowEnrollment(): Promise<void> {
  const active = requireBurrowLink();
  await active.command('clearEnrollment');
  await refreshAfterMutation();
}

/**
 * Mint the code behind this machine's setup QR (`docs/specs/relay.md` → Setup
 * tokens). Unlike everything above it, this changes nothing the status reports,
 * so it does not re-read one.
 *
 * The token rides back inside the URL, which is the point: it exists to be shown
 * to whoever is standing at this machine (`service-protocol.ts` →
 * `SetupQrResult`). Rejections propagate verbatim — a relay that is down and a
 * Relay that refuses both have to read as themselves.
 */
export async function mintSetupQr(): Promise<SetupQrResult> {
  const active = requireBurrowLink();
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
 * would be a *value* import of `burrow-runtime.ts` from the main chunk — the whole
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
    burrowLink()?.on('invitation', (data) => {
      const event = data as InvitationEvent | undefined;
      if (typeof event?.inviteId === 'string' && typeof event.state === 'string') {
        const outcome = typeof event.outcome === 'string' ? event.outcome : undefined;
        listener(event.inviteId, event.state, outcome);
      }
    }) ?? (() => {})
  );
}

/**
 * Ask the Burrow service to send a test push and report what happened
 * (`PushSendSummary` in `service-protocol.ts` — the same type the service's
 * `pushTest` command answers with, so the two ends cannot drift).
 *
 * Rejects when there is no service, no enrollment, or the Relay refused —
 * unlike the ring path, which swallows everything so a failed push can never
 * break an alarm (`docs/specs/relay.md` -> Web Push). A test button is the one
 * caller that needs the failure.
 *
 * Lives here rather than beside the device refresh in `activation.ts`: that
 * module is deliberately inside the lazily-imported `RemotePairingModalHost`
 * chunk, and importing it from the Settings dialog would pull the whole
 * Burrow stack into the main bundle on every host.
 */
export async function sendTestPush(): Promise<PushSendSummary> {
  const active = requireBurrowLink();
  return (await active.command('pushTest')) as PushSendSummary;
}

export function describeBurrowError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  if (typeof error === 'string' && error) return error;
  // Completes the section's own sentence — "Could not reach this machine's
  // remote-control service: …" — so it does not name the service again, in the
  // internal word at that (`RemoteControlSection.tsx`).
  return 'It did not answer.';
}

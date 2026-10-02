/**
 * The bridge between the Node-resident Burrow service and the webview that shows
 * its UI. Shared by both ends so the contract cannot drift: the service imports
 * it to dispatch, the webview imports it to speak.
 *
 * Three message kinds, all JSON:
 *
 *   webview → service   `burrow:command`  { burrowRequestId, cmd, params? }
 *   service → webview   `burrow:result`   { burrowRequestId, result } | { burrowRequestId, error }
 *   service → webview   `burrow:ask`      { burrowRequestId, op, params }
 *   service → webview   `burrow:event`    { name, ... }
 *
 * ⚠ The correlation field is `burrowRequestId`, never `requestId`. The standalone Rust
 * bridge swallows any sidecar line whose `data.requestId` matches a pending
 * invoke (`standalone/src-tauri/src/lib.rs`), so a `requestId` here would make
 * results vanish at random.
 *
 * The service asks the webview only what the webview alone knows: what its
 * panes are called and how big its terminals are. Everything else — the relay
 * socket, the enrollment, the ACL, the access decision — is the service's, and
 * a webview answer can never widen it.
 */

import type {
  InvitationState,
  PairingOutcome,
  BurrowStatus,
} from '../../remote/burrow/burrow-runtime';
import type { OneTimeState } from '../../remote/burrow/one-time-runtime';
import { isPathRefusal } from '../../remote/direct/path-refusal';
import type { NetworkLevel, NetworkPolicy, NetworkPolicyResult } from '../../remote/network-policy';
import type { RelayMode } from '../relay-origin';

/** Transport event names for what the service sends back. */
export const BURROW_RESULT_EVENT = 'burrow:result';
export const BURROW_ASK_EVENT = 'burrow:ask';
export const BURROW_EVENT_EVENT = 'burrow:event';

/**
 * How long the service waits for the webview to answer an ask before it
 * proceeds with what it has. An attach must not hang on a webview that is
 * mid-reload, and a directory snapshot that misses a pane is recoverable — the
 * next change re-collects.
 */
export const ASK_BUDGET_MS = 1_000;

/** webview → service. `params` is the command's own shape, below. */
export interface BurrowCommand {
  burrowRequestId: string;
  cmd: string;
  params?: unknown;
  /**
   * Which webview sent this, stamped by a host that has more than one
   * (`burrow_command` in `standalone/src-tauri/src/lib.rs`). The webview never
   * sets it — it does not know its own label to the Burrow — and a host with one
   * unnamed webview omits it. Read only by the N-answer collector, which settles
   * an ask on having heard from every window rather than on a count.
   */
  window?: string;
}

/** Validate the untrusted edge of either Burrow bridge before routing a command. */
export function isBurrowCommand(value: unknown): value is BurrowCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<BurrowCommand>;
  return typeof command.burrowRequestId === 'string' && typeof command.cmd === 'string';
}

/** service → webview, in reply to a command that has a result. */
export interface BurrowResult {
  burrowRequestId: string;
  result?: unknown;
  error?: string;
}

/** service → webview: answer with `answer` naming this `burrowRequestId`. */
export interface BurrowAsk {
  burrowRequestId: string;
  op: string;
  params: unknown;
}

/**
 * Which ceremony a request awaiting local confirmation belongs to: a pairing,
 * which writes an ACL record, or a one-time connection, which authorizes one
 * session and writes nothing (`docs/specs/one-time.md`).
 *
 * **A message that names none is a `pairing`.** A webview or broker from before
 * the field existed sends none, and reading that as a pairing fails closed: the
 * one-time request is never in the pairing queue, so an old modal's answer
 * finds nothing to approve.
 */
export type ApprovalKind = 'pairing' | 'one-time';

/** The kind an untrusted message names, with a missing or unknown one read as `pairing`. */
export function approvalKind(value: { kind?: unknown } | null | undefined): ApprovalKind {
  return value?.kind === 'one-time' ? 'one-time' : 'pairing';
}

/**
 * One request awaiting local confirmation, as the webview mirrors it.
 *
 * **The expected two-digit code is deliberately absent.** The webview echoes
 * what a person typed and the Burrow compares it; a mirrored code would make the
 * confirmation something anything in this realm could satisfy
 * (`docs/specs/remote-security-model.md` → Pairing). Nothing else about the
 * Client crosses either: the presence proof already verified, so the only thing
 * left for the human to decide is whether the phone in their hand is the one
 * asking.
 */
export interface PairingQueueItem {
  /** Which modal copy it gets, and which half of the service its answer goes to. */
  kind: ApprovalKind;
  /** The Relay's client socket id; `''` for a one-time request, which has no Relay. */
  clientId: string;
  /** Immutable ceremony id, echoed by approve/deny. */
  pairingId: string;
  /**
   * The Client's own name for itself, already bounded and stripped by the
   * Burrow; a one-time request's is a member of `ONE_TIME_DEVICE_LABELS`.
   */
  label: string;
  requestedAt: number;
}

/**
 * service → webview, unsolicited. The queue snapshot is complete every time:
 * the service is authoritative, so the webview replaces rather than merges.
 */
export interface PairingQueueEvent {
  name: 'pairing-queue';
  queue: PairingQueueItem[];
}

/**
 * service → webview, whenever the Burrow's lifecycle changes whether there is one
 * at all, and once as the service starts. What a webview does for the Burrow
 * costs a crossing per pane-state, activity, and focus change, so an
 * installation that never enrolled must pay none of it
 * (`lib/src/remote/burrow/enrolled-gate.ts`).
 */
export interface BurrowStatusEvent {
  name: 'status';
  enrolled: boolean;
  /**
   * Whether anything can reach this machine's terminals: enrolled, or a
   * one-time connection opening, waiting, confirming, or live. What the
   * surface responder and the approval mirror arm on; push stays on
   * `enrolled`. Absent from a broker older than the field: read it through
   * {@link servingOf}.
   */
  serving: boolean;
  /**
   * Which service instance is speaking: minted per `BurrowService`, and
   * carried on every size hold its sessions take (`SurfaceHold.serviceId`). A
   * webview drops the holds of any other instance — a VS Code broker window
   * that closed, a sidecar that restarted — since nothing will release them
   * (`docs/specs/remote-api.md` → "Size authority"). Absent from a broker
   * older than the field: read it through {@link serviceIdOf}.
   */
  serviceId: string;
}

/**
 * Whether a `status` answer or event says something can reach this machine's
 * terminals. **A missing `serving` reads as `enrolled`**: a VS Code broker from
 * before one-time connections sends none, and enrolled is all it could be
 * serving on.
 */
export function servingOf(
  status: Partial<Pick<BurrowStatusEvent, 'enrolled' | 'serving'>> | null | undefined,
): boolean {
  return typeof status?.serving === 'boolean' ? status.serving : !!status?.enrolled;
}

/**
 * Whether `connection` is a Relay that no longer takes this Burrow (a
 * `BurrowStanding` latched, `docs/specs/burrow-service.md` -> "Burrow side"), which the
 * Burrow asks for nothing more: no push, device list, setup code, or relay row.
 */
export function relayRefuses(connection: BurrowStatus): boolean {
  return connection === 'removed' || connection === 'not-entitled';
}

/**
 * The service instance a `status` event names, or `null` where it names none —
 * a broker older than the field — which drops no hold.
 */
export function serviceIdOf(status: { serviceId?: unknown } | null | undefined): string | null {
  return typeof status?.serviceId === 'string' && status.serviceId ? status.serviceId : null;
}

/**
 * service → webview: the one-time connection moved, or the service started
 * (`docs/specs/one-time.md`). The state is complete every time, so a panel
 * replaces rather than merges; `oneTimeStatus` answers the same state, for a
 * panel that opens after it.
 *
 * **Its `waiting.url` is the link itself** — the room id and the one-use
 * public key, a capability to ask for the one confirmation — and crosses for the
 * reason `SetupQrResult.url` does: it exists to be shown to the person at this
 * machine. Single-use and short-lived; the private half never leaves the Burrow.
 */
export interface OneTimeEvent {
  name: 'one-time';
  state: OneTimeState;
}

/**
 * service → webview: the network policy changed (`docs/specs/remote-network.md`
 * -> "Policy"), or the path refusal it carries did. Complete every time, so a
 * reader replaces rather than merges; `networkPolicy` and `dismissPathRefusal`
 * answer the same shape, for a reader that arrives after it.
 */
export interface NetworkPolicyEvent extends NetworkPolicyResult {
  name: 'network-policy';
}

/** Every `burrow:event` the service sends, by `name`. */
export type BurrowUiEvent =
  | BurrowStatusEvent
  | PairingQueueEvent
  | InvitationEvent
  | OneTimeEvent
  | NetworkPolicyEvent;

/**
 * The one-time state of a Burrow with no connection, from this build's
 * `hostedOrigin` (`../relay-origin.ts`) and the network policy's level:
 * `unavailable` without a Hosted origin — a self-host build, which opens no
 * rendezvous — or under `nothing`, else `idle`. One builder for every process
 * that answers it: the service, the VS Code glue for a window with no service
 * at all (`vscode-ext/src/burrow.ts` → `refuseCommand`), and the Storybook stub.
 */
export function idleOneTimeState(hosted: string | null, level: NetworkLevel): OneTimeState {
  if (hosted === null) return { status: 'unavailable', reason: 'self-host' };
  return level === 'nothing' ? { status: 'unavailable', reason: 'network-off' } : { status: 'idle' };
}

/**
 * Whether `value` is a {@link OneTimeState} a panel can render: a known
 * `status` carrying the fields that status needs. A reason is only checked to
 * be a string — a panel keeps fixed copy per reason and falls back for one this
 * build does not know, since a VS Code broker may be a newer build — and an
 * ending's `refusal`, where present, to pass `isPathRefusal`.
 */
export function isOneTimeState(value: unknown): value is OneTimeState {
  if (!value || typeof value !== 'object') return false;
  const state = value as Record<string, unknown>;
  switch (state.status) {
    case 'idle':
    case 'opening':
      return true;
    case 'unavailable':
      return typeof state.reason === 'string';
    case 'ended':
      return typeof state.reason === 'string' && (state.refusal === undefined || isPathRefusal(state.refusal));
    case 'waiting':
      return typeof state.url === 'string' && typeof state.expiresAt === 'number';
    case 'confirming':
      return typeof state.label === 'string' && typeof state.expiresAt === 'number';
    case 'connecting':
      return typeof state.label === 'string';
    case 'connected':
      return typeof state.label === 'string' && typeof state.since === 'number';
    default:
      return false;
  }
}

/**
 * service → webview, unsolicited: one of this Burrow's invitations changed state,
 * so the panel displaying its QR can stop offering a code that can no longer be
 * used. The Burrow's own map is the authority — this is display truth.
 *
 * Named by `inviteId` ({@link SetupQrResult.inviteId}), so a panel acts only on
 * its own and two open windows do not both go stale over one scan. Never the
 * setup token or the invitation key: correlating must not put a credential on a
 * wire that carries none.
 */
export interface InvitationEvent {
  name: 'invitation';
  inviteId: string;
  state: InvitationState;
  /**
   * How the ceremony this code produced ended, where one did — the only way the
   * Settings panel can tell a mistyped confirmation from a success
   * (`PairingOutcome`). **On this event rather than beside it**, because the two
   * are one transition: carrying them together is what keeps the panel from
   * painting the state-only sentence and then correcting itself. Absent means
   * nobody decided anything.
   */
  outcome?: PairingOutcome;
}

// --- Command parameter shapes ---

/**
 * No Relay URL: the only Relay a Burrow enrolls with is its build's baked
 * origin (`docs/specs/burrow-service.md` → "Relay origin").
 */
export interface EnrollParams {
  password: string;
  label: string;
}

/**
 * One-click enrollment against the offer an installer left on this machine
 * (`docs/specs/burrow-service.md` → "Remote control, in the Settings dialog").
 */
export interface EnrollOfferParams {
  /** No token: it comes off the file, which the service re-reads at the click. */
  label: string;
}

/**
 * A Hosted build's device-code enrollment (`docs/specs/hosted.md` -> "Burrow
 * enrollment"): `beginHostedEnrollment` takes the name to keep for this
 * machine, and the service does the rest, reporting through `status`
 * ({@link HostedEnrollmentState}). No origin and no URL: both are the build's.
 */
export interface HostedEnrollParams {
  label: string;
}

/** `kind`, `clientId`, and `pairingId` echo the {@link PairingQueueItem} the modal displayed. */
export interface ApproveParams {
  /** Read through {@link approvalKind}: absent is a `pairing`. */
  kind?: ApprovalKind;
  clientId: string;
  pairingId: string;
  /** The two digits the person read off the phone; the Burrow compares them. */
  code: string;
}

export interface DenyParams {
  /** Read through {@link approvalKind}: absent is a `pairing`. */
  kind?: ApprovalKind;
  clientId: string;
  pairingId: string;
}

/**
 * A pane strip's Take back (`docs/specs/remote-api.md` → "Size authority"):
 * end the remote session whose holder id the pane was held under. The id is
 * opaque and names one live session; knowing one lets a webview end that
 * session, which its person can already do from the panel, and nothing else.
 */
export interface TakeBackParams {
  holder: string;
}

/** Whether a session was ended. `false` when none holds under that id any more. */
export interface TakeBackResult {
  ended: boolean;
}

/**
 * The whole policy to hold from now on (`docs/specs/remote-network.md` ->
 * "Policy"). The service takes it only exactly: a level this build offers, at
 * most `MAX_ALLOWED_NETWORKS` CIDRs, a boolean `autoUpdate` — and saves, and
 * answers, each CIDR in its canonical form.
 */
export interface SetNetworkPolicyParams {
  policy: NetworkPolicy;
}

/** Answers an outstanding {@link BurrowAsk}; `burrowRequestId` is the ask's, not a new one. */
export interface AnswerParams {
  burrowRequestId: string;
  results: unknown[];
}

// --- Command results ---

export interface EnrollResult {
  burrowId: string;
}

/**
 * What `setupQr` answers: the URL to render as a QR, which invitation it
 * belongs to, and when it stops working.
 *
 * **The QR's secrets ride into the webview inside `url`, on purpose.** That is
 * the whole point of the command — the code is displayed to a person standing
 * at this machine, and displaying it *is* the local-presence act
 * (`docs/specs/remote-security-model.md` → Pairing). They are the only
 * credentials in this contract that cross that seam: `burrowToken` still never
 * does (`docs/specs/security-remote.md` → "Trust boundary", the no-`burrowToken`-in-a-webview FAIL IF), and neither
 * does the installer offer's token ({@link BurrowConsoleStatus.offer}), nor
 * the invitation's *private* key, which never leaves the Burrow.
 */
export interface SetupQrResult {
  /**
   * The pairing URL, composed by the service from the origin this Burrow enrolled
   * against — `remote-lib-common`'s `formatPairingInvitationUrl` owns its
   * grammar (`docs/specs/relay.md` → "Setup tokens and the pairing QR").
   */
  url: string;
  /**
   * Names this invitation, so {@link InvitationEvent} can say which code was
   * used without naming any of its secrets.
   */
  inviteId: string;
  /** Epoch ms after which neither the token nor the invitation works. */
  expiresAt: number;
}

/**
 * Why a Hosted enrollment stopped short of enrolling, each read as fixed copy
 * but `failed`, which carries the service's sentence. `answer-lost` is an
 * approval an earlier poll redeemed whose answer never arrived. A reason this
 * build does not know reads as `failed` with no sentence.
 */
export const HOSTED_ENROLLMENT_END_REASONS = ['expired', 'not-entitled', 'answer-lost', 'failed'] as const;
export type HostedEnrollmentEndReason = (typeof HOSTED_ENROLLMENT_END_REASONS)[number];

/**
 * A Hosted build's device-code enrollment as `status` reports it: `waiting`
 * for the account to approve `userCode`; `redeeming` once a poll redeemed it,
 * until the enrollment is saved and started (so status always shows a code or
 * an enrollment); or `ended` without an enrollment, until the next begin or a
 * cancel. A success reports none: `enrolled` says it. `accountFull` is an
 * approval the account cannot redeem until it removes a computer, which the
 * Relay keeps, so the service polls on.
 *
 * **Never the device code**, which is a bearer the service holds as it holds
 * `burrowToken` (`docs/specs/security-remote.md` -> "Trust boundary").
 * `verificationUrl` is the account page the service composed, which the panel
 * opens on a click; `expiresAt` is this machine's clock.
 */
export type HostedEnrollmentState =
  | { status: 'waiting'; userCode: string; verificationUrl: string; expiresAt: number; accountFull: boolean }
  | { status: 'redeeming' }
  | ({ status: 'ended' } & HostedEnrollmentEnded);

/**
 * How a Hosted enrollment ended short of enrolling: `message` is `failed`'s
 * sentence, and `burrowId` the Burrow an `answer-lost` approval enrolled, which
 * the account must remove.
 */
export interface HostedEnrollmentEnded {
  reason: HostedEnrollmentEndReason;
  message?: string;
  burrowId?: string;
}

/**
 * What `window.dormouseBurrow.status()` prints. `docs/specs/relay.md`
 * documents the console hook, so these field names are user-facing surface.
 */
export interface BurrowConsoleStatus {
  enrolled: boolean;
  /** {@link BurrowStatusEvent.serving}, which this seeds. */
  serving: boolean;
  /**
   * The one relay origin this build was baked with, enrolled or not, and the
   * mode it sets — what the Settings dialog renders (`docs/specs/burrow-service.md` →
   * "Relay origin").
   */
  relayOrigin: string;
  relayMode: RelayMode;
  burrowId: string | null;
  /**
   * The relay socket's state. The latched ones need acting on, since no timer
   * brings them back (`docs/specs/burrow-service.md` -> "Burrow side", relay socket
   * policy): `displaced` — another Dormouse instance enrolled with the same
   * `burrowId` took the relay slot, and `reconnect()` takes it back;
   * `removed` — the Relay no longer knows this Burrow; `not-entitled` — its
   * Hosted account no longer includes the Relay.
   */
  connection: BurrowStatus;
  pairedClients: number;
  /** What to prefill a "name for this machine" field with: the hostname. */
  suggestedLabel: string;
  /**
   * Whether the installer left an enrollment offer for `relayOrigin` on this
   * machine, while this self-host Burrow has not enrolled — the Settings
   * dialog's one-click path (`docs/specs/burrow-service.md` → "Remote control, in the
   * Settings dialog").
   *
   * **The offer's `token` is never here.** This is a service→webview shape, and
   * the token is a bearer credential exactly like `burrowToken` (`docs/specs/security-remote.md` → "Trust boundary",
   * the no-`burrowToken`-in-a-webview FAIL IF).
   */
  offer: boolean;
  /**
   * The device-code enrollment in a Hosted build, or `null` where none was
   * begun since the last cancel or success, and always in a self-host build.
   */
  hostedEnrollment: HostedEnrollmentState | null;
  /**
   * The Hosted account's origin, where its computers are managed:
   * `HOSTED_ACCOUNT_ORIGIN` in a release Hosted build, the origin the last
   * begin resolved in a dev one (`null` before any), `null` in a self-host
   * build.
   */
  accountOrigin: string | null;
}

/**
 * The devices a push would reach, or `null` when no Burrow is running — which is
 * "nowhere to push", not "the Relay could not be asked" (`push-devices.ts`).
 *
 * Labels only. The ACL record's `deliveryId` is a bearer capability for that
 * Client's push rows and never crosses into the webview realm, which has no
 * route that takes one (`docs/specs/security-remote.md` → "What crosses the boundary").
 */
export type PushDevicesResult = { devices: Array<{ label: string }> } | null;

/**
 * What one push fan-out actually did: the result of the `pushTest` command, and
 * the return of `sendPush` itself (`push-delivery.ts`) — one type on both ends
 * of the bridge, so the button and the service cannot drift.
 *
 * The ring path ignores it — a failed push must never break the alert path —
 * but the Settings dialog's test button exists *only* to report it, and "sent"
 * over a fan-out that reached nobody would be worse than no button at all.
 *
 * `targeted` is 0 when the ACL authorized no device — the ordinary answer on a
 * freshly enrolled machine, and a distinct outcome from a send that was
 * attempted and refused: nothing was even tried.
 */
export interface PushSendSummary {
  targeted: number;
  delivered: number;
  failed: number;
}

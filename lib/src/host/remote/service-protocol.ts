/**
 * The bridge between the Node-resident Host service and the webview that shows
 * its UI. Shared by both ends so the contract cannot drift: the service imports
 * it to dispatch, the webview imports it to speak.
 *
 * Three message kinds, all JSON:
 *
 *   webview → service   `remoteHost:command`  { rhId, cmd, params? }
 *   service → webview   `remoteHost:result`   { rhId, result } | { rhId, error }
 *   service → webview   `remoteHost:ask`      { rhId, op, params }
 *   service → webview   `remoteHost:event`    { name, ... }
 *
 * ⚠ The correlation field is `rhId`, never `requestId`. The standalone Rust
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
  RemoteHostStatus,
} from '../../remote/host/remote-host';

/** Transport event names for what the service sends back. */
export const REMOTE_HOST_RESULT_EVENT = 'remoteHost:result';
export const REMOTE_HOST_ASK_EVENT = 'remoteHost:ask';
export const REMOTE_HOST_EVENT_EVENT = 'remoteHost:event';

/**
 * How long the service waits for the webview to answer an ask before it
 * proceeds with what it has. An attach must not hang on a webview that is
 * mid-reload, and a directory snapshot that misses a pane is recoverable — the
 * next change re-collects.
 */
export const ASK_BUDGET_MS = 1_000;

/** webview → service. `params` is the command's own shape, below. */
export interface RemoteHostCommand {
  rhId: string;
  cmd: string;
  params?: unknown;
}

/** Validate the untrusted edge of either Host bridge before routing a command. */
export function isRemoteHostCommand(value: unknown): value is RemoteHostCommand {
  if (!value || typeof value !== 'object') return false;
  const command = value as Partial<RemoteHostCommand>;
  return typeof command.rhId === 'string' && typeof command.cmd === 'string';
}

/** service → webview, in reply to a command that has a result. */
export interface RemoteHostResult {
  rhId: string;
  result?: unknown;
  error?: string;
}

/** service → webview: answer with `answer` naming this `rhId`. */
export interface RemoteHostAsk {
  rhId: string;
  op: string;
  params: unknown;
}

/**
 * One pairing awaiting local confirmation, as the webview mirrors it.
 *
 * **The expected two-digit code is deliberately absent.** The webview echoes
 * what a person typed and the Host compares it; a mirrored code would make the
 * confirmation something anything in this realm could satisfy
 * (`docs/specs/remote-security-model.md` → Pairing). Nothing else about the
 * Client crosses either: the presence proof already verified, so the only thing
 * left for the human to decide is whether the phone in their hand is the one
 * asking.
 */
export interface PairingQueueItem {
  clientId: string;
  /** Immutable ceremony id, echoed by approve/deny. */
  pairingId: string;
  /** The Client's own name for itself, already bounded and stripped by the Host. */
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
 * service → webview, whenever the Host's lifecycle changes whether there is one
 * at all. What a webview does for the Host costs a crossing per pane-state,
 * activity, and focus change, so an installation that never enrolled must pay
 * none of it (`lib/src/remote/host/enrolled-gate.ts`).
 */
export interface HostStatusEvent {
  name: 'status';
  enrolled: boolean;
}

/**
 * service → webview, unsolicited: one of this Host's invitations changed state,
 * so the panel displaying its QR can stop offering a code that can no longer be
 * used. The Host's own map is the authority — this is display truth.
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

export interface EnrollParams {
  serverUrl: string;
  password: string;
  label: string;
}

/**
 * One-click enrollment against the offer an installer left on this machine
 * (`docs/specs/server.md` → "Remote control, in the Settings dialog").
 */
export interface EnrollOfferParams {
  /**
   * The origin the card displayed, echoed back so the service can refuse an
   * offer file that was rewritten between the render and the click. **Not the
   * origin that is enrolled against** — that comes off the file, along with the
   * token this shape deliberately does not carry.
   */
  origin: string;
  label: string;
}

export interface ApproveParams {
  clientId: string;
  pairingId: string;
  /** The two digits the person read off the phone; the Host compares them. */
  code: string;
}

export interface DenyParams {
  clientId: string;
  pairingId: string;
}

/** The webview names the Session and what to call it; recipients are never its call. */
export interface PushParams {
  sessionId: string;
  title: string;
}

/** Answers an outstanding {@link RemoteHostAsk}; `rhId` is the ask's, not a new one. */
export interface AnswerParams {
  rhId: string;
  results: unknown[];
}

// --- Command results ---

export interface EnrollResult {
  hostId: string;
  serverUrl: string;
}

/**
 * What `setupQr` answers: the URL to render as a QR, which invitation it
 * belongs to, and when it stops working.
 *
 * **The QR's secrets ride into the webview inside `url`, on purpose.** That is
 * the whole point of the command — the code is displayed to a person standing
 * at this machine, and displaying it *is* the local-presence act
 * (`docs/specs/remote-security-model.md` → Pairing). They are the only
 * credentials in this contract that cross that seam: `hostToken` still never
 * does (`docs/specs/security-application.md` → "Trust boundary", the no-`hostToken`-in-a-webview FAIL IF), and neither
 * does the installer offer's token ({@link RemoteHostConsoleStatus.offer}), nor
 * the invitation's *private* key, which never leaves the Host.
 */
export interface SetupQrResult {
  /**
   * The pairing URL, composed by the service from the origin this Host enrolled
   * against — `server-lib-common`'s `formatPairingInvitationUrl` owns its
   * grammar (`docs/specs/server.md` → QR grammar).
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
 * What `window.dormouseRemoteHost.status()` prints. `docs/specs/server.md`
 * documents the console hook, so these field names are user-facing surface.
 */
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
  /** What to prefill a "name for this machine" field with: the hostname. */
  suggestedLabel: string;
  /**
   * The installer's enrollment offer on this machine, when there is one and this
   * Host has not enrolled — the Settings dialog's one-click path
   * (`docs/specs/server.md` → "Remote control, in the Settings dialog", which
   * owns the re-read-at-click rule and what makes the card safe to press).
   *
   * **The offer's `token` is never here.** This is a service→webview shape, and
   * the token is a bearer credential exactly like `hostToken` (`docs/specs/security-application.md` → "Trust boundary",
   * the no-`hostToken`-in-a-webview FAIL IF).
   */
  offer: { origin: string } | null;
}

/**
 * The devices a push would reach, or `null` when no Host is running — which is
 * "nowhere to push", not "the server could not be asked" (`push-devices.ts`).
 *
 * Labels only. The ACL record's `deliveryId` is a bearer capability for that
 * Client's push rows and never crosses into the webview realm, which has no
 * route that takes one (`docs/specs/security-application.md` → "What crosses the boundary").
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

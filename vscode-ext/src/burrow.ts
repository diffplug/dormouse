/** VS Code binding of {@link BurrowService}; see `docs/specs/vscode.md` → "Burrow: a service in the extension host". */

import type * as vscode from 'vscode';

import {
  createAskSurfaceProvider,
  type AskSurfaceProvider,
} from '../../lib/src/host/remote/ask-surface-provider';
import { readEnrollmentOffer } from '../../lib/src/host/remote/enroll-offer';
import { BURROW_COMMAND_TIMEOUT_MS } from '../../lib/src/host/remote/link-client';
import {
  createNativeDirectPeerFactory,
  disposeNativeDirectPeers,
} from '../../lib/src/host/remote/native-direct-peer';
import { listNetworkInterfaces } from '../../lib/src/host/remote/network-interfaces';
import { networkPolicyResult, type NetworkPolicy } from '../../lib/src/remote/network-policy';
import { bakedRelay, hostedOrigin } from '../../lib/src/host/relay-origin';
import {
  BurrowService,
  loadEnrollmentFor,
  oneTimeServing,
  peekNetworkPolicyFor,
  readUsableOffer,
  unenrolledStatus,
} from '../../lib/src/host/remote/service';
import {
  BURROW_EVENT_EVENT,
  BURROW_RESULT_EVENT,
  idleOneTimeState,
  isBurrowCommand,
  isOneTimeState,
  type OneTimeEvent,
  type PairingQueueItem,
  type PushDevicesResult,
  type BurrowCommand,
  type BurrowConsoleStatus,
  type BurrowResult,
  type TakeBackResult,
} from '../../lib/src/host/remote/service-protocol';
import type { BurrowSurfaceProvider } from '../../lib/src/remote/burrow/burrow-surface-provider';
import type {
  PeerSurfaceParams,
  PeerSurfaceResult,
} from '../../lib/src/remote/burrow/peer-surfaces';
import {
  MAX_RELAY_TO_BURROW_FRAME_LENGTH,
  type WebSocketLike,
} from '../../lib/src/remote/burrow/burrow-runtime';
import type { ExtensionMessage } from './message-types';
import {
  broadcastUiEvent,
  ensurePeerNet,
  forwardCommand,
  forwardPush,
  isPeerLinkSettled,
  isRemotePtyHandle,
  onPeerLinkSettled,
  remoteRequest,
  remoteResize,
  remoteSubscribe,
  remoteUnsubscribe,
  remoteWrite,
  sendCommandResult,
  sendUiEvent,
  type PeerLinkClient,
} from './peer-link';
import type { PtySink } from './processed-pty-streams';
import { VsCodeBurrowStateStore } from './burrow-store';
import type { ManagedVoiceCredential } from '../../lib/src/host/managed-voice-host';
import { log } from './log';

/**
 * What this module needs from the router, injected rather than imported: the
 * router routes commands here, so importing back would be a cycle.
 */
export interface BurrowDeps {
  /** Fan one question out to this window's webviews and collect the answers. */
  brokerRequest(op: string, params: unknown): Promise<unknown[]>;
  /** Post to every live webview in this window. */
  broadcastToWebviews(message: ExtensionMessage): void;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number, repaint?: boolean): void;
  /**
   * Watch one PTY this window owns, through the window's shared keyed registry
   * (`processed-pty-streams.ts`) rather than a registry of its own per attachment.
   */
  streamPty(ptyId: string, sink: PtySink): () => void;
  /** This window's managed voice, which a Hosted sign-in hands its token (`managed-voice.ts`). */
  voiceCredential?(): ManagedVoiceCredential | undefined;
}

let deps: BurrowDeps | null = null;

export function configureBurrow(next: BurrowDeps): void {
  deps = next;
}

let context: vscode.ExtensionContext | null = null;
/**
 * One store for the window: `SecretStorage` is a keychain round trip, and the
 * activation probe and the service would otherwise each pay for their own.
 */
let store: VsCodeBurrowStateStore | null = null;
let service: BurrowService | null = null;
let askProvider: AskSurfaceProvider | null = null;

/**
 * Ask both tiers at once and concatenate what they answer, this window's
 * webviews first. A follow-up carrying an owner key goes only to the tier (and,
 * for a peer handle, the exact window) selected during resolution.
 *
 * Both at once rather than the near tier first: whatever is asked about lives
 * in exactly one webview of one window, so asking in series would spend a whole
 * tier's budget before the window that actually owns it is even asked. The
 * results carry no tier marker because nothing downstream needs one — a
 * directory is a concatenation, and the first surface owner is retained by its
 * provider-local PTY key.
 */
async function askBothTiers(
  bound: BurrowDeps,
  op: string,
  params: unknown,
  ownerPtyId?: string,
): Promise<unknown[]> {
  // A mutating attach cannot itself discover its owner: duplicated cold-restored
  // windows may both answer the same surface id, which would resize both xterms
  // before the first result was selected. Probe identity read-only, then send
  // the attach only to the tier/window carried by that provider-local PTY key.
  const surfaceParams = params as Partial<PeerSurfaceParams> | null;
  if (!ownerPtyId && op === 'surfaceOp' && surfaceParams?.op === 'attach') {
    const [owner] = (await askBothTiers(bound, op, {
      ...surfaceParams,
      op: 'resolve',
    })) as PeerSurfaceResult[];
    return owner ? askBothTiers(bound, op, params, owner.ptyId) : [];
  }
  if (ownerPtyId) {
    return isRemotePtyHandle(ownerPtyId)
      ? remoteRequest(op, params, ownerPtyId)
      : bound.brokerRequest(op, params);
  }
  // Local first: a duplicated id is shown from, and attaches to, the in-window owner.
  const [local, remote] = await Promise.all([
    bound.brokerRequest(op, params),
    remoteRequest(op, params),
  ]);
  return [...local, ...remote];
}

/**
 * Build the provider the service serves remote-api v1 through.
 *
 * PTYs owned by this window are answered locally — this process owns them —
 * while everything about the *view* of them is asked of the webviews, because a
 * window's terminals are spread across however many Dormouse views are open and
 * only they hold an xterm registry. Every one of those questions also goes to
 * the other windows over the link, so the phone sees one directory of every
 * terminal on the machine rather than the broker window's alone.
 */
export function createBurrowProvider(bound: BurrowDeps): BurrowSurfaceProvider {
  askProvider = createAskSurfaceProvider(
    (op, params, ownerPtyId) => askBothTiers(bound, op, params, ownerPtyId),
    {
      // A peer-returned provider handle stays in the link's namespace even
      // after its route closes; it must never fall through to a local PTY that
      // later happens to claim the same string.
      writePty: (ptyId, data) => {
        if (isRemotePtyHandle(ptyId)) {
          remoteWrite(ptyId, data);
          return;
        }
        bound.writePty(ptyId, data);
      },
      resizePty: (ptyId, cols, rows, repaint) => {
        if (isRemotePtyHandle(ptyId)) {
          remoteResize(ptyId, cols, rows, repaint);
          return;
        }
        bound.resizePty(ptyId, cols, rows, repaint);
      },

      streamPty(ptyId, sink) {
        if (isRemotePtyHandle(ptyId)) {
          // Another window's terminal: it has already stripped the protocol out
          // on its side, so what arrives over the link is what its own xterm
          // renders — the same stream shape as the local branch below.
          const ready = remoteSubscribe(ptyId, sink);
          return {
            stop: () => remoteUnsubscribe(ptyId, sink),
            ready,
          };
        }
        // One of this window's own, through the keyed registry every consumer of
        // the processed stream shares (`processed-pty-streams.ts`).
        return {
          stop: bound.streamPty(ptyId, sink),
          ready: Promise.resolve(),
        };
      },
    },
  );
  return askProvider.provider;
}

/**
 * Something a future directory answer could depend on changed: a pane, an
 * alert, a webview, a peer window.
 */
export function notifyDirectoryChanged(): void {
  askProvider?.notifyDirectoryChanged();
}

/**
 * The relay socket, preferring whatever this extension host already provides.
 *
 * `globalThis.WebSocket` only landed in Node 22, and `engines.vscode` here is
 * `^1.92.0` — VS Code 1.92 shipped Node 20.14, and the supported range spans
 * the boundary — so on an older host there is no global to use and the bundled
 * `ws` is the only implementation. Its socket satisfies the same
 * surface `BurrowRuntime` reads and nothing more: `send`, `close`, `readyState`,
 * `addEventListener`, with `message` events carrying `.data` and `close` events
 * carrying `.code`.
 *
 * `ws`'s optional native accelerators (`bufferutil`, `utf-8-validate`) are
 * deliberately left unbundled and unshipped; `ws` falls back to its JS paths.
 *
 * `ws` defaults `maxPayload` to 100 MiB, which a hostile relay would spend in
 * this process — the extension host, holding every PTY. Cap it at the largest
 * legal frame so an oversized one is never buffered; `BurrowRuntime` re-measures
 * the same bound before parsing, because the global implementation takes no
 * such option.
 */
export function createRelaySocket(url: string): WebSocketLike {
  const global = globalThis.WebSocket;
  if (global) return new global(url) as unknown as WebSocketLike;
  const Ws = (require('ws') as typeof import('ws')).WebSocket;
  return new Ws(url, { maxPayload: MAX_RELAY_TO_BURROW_FRAME_LENGTH }) as unknown as WebSocketLike;
}

/**
 * What this window last wrote to the one-time serving marker, so only a flip
 * writes; `null` until the service's start has written it.
 */
let servingMarked: boolean | null = null;

/**
 * Tell every window whether this broker's one-time connection is serving
 * (`ONE_TIME_SERVING_KEY` in `burrow-store.ts`). A window with no enrollment
 * contends only for a reason it can read off `SecretStorage`, and without this
 * one it would never join the peer net — its terminals would be missing from
 * what the phone sees.
 */
function markOneTimeServing(serving: boolean): void {
  if (!context || servingMarked === serving) return;
  servingMarked = serving;
  void burrowStateStore(context)
    .saveOneTimeServing(serving)
    .catch((error: unknown) => {
      log.error(`[burrow] could not write the one-time serving marker: ${String(error)}`);
    });
}

function startService(): void {
  if (service || !context || !deps) return;
  const bound = deps;
  // A marker a previous broker left — a window that closed or crashed while
  // serving — names a connection that is gone with it.
  servingMarked = null;
  markOneTimeServing(false);
  service = new BurrowService({
    store: burrowStateStore(context),
    provider: createBurrowProvider(bound),
    kind: 'vscode',
    createWebSocket: createRelaySocket,
    sendToUi: (event, data) => {
      if (event === BURROW_RESULT_EVENT) {
        answer(data as BurrowResult);
      } else if (event === BURROW_EVENT_EVENT) {
        // Every window, not just this one: the pairing modal can be answered
        // from whichever webview the user happens to be looking at, and only
        // the windows that see the queue can show one.
        bound.broadcastToWebviews({ type: 'burrow:event', payload: data });
        broadcastUiEvent(data);
        const oneTime = data as Partial<OneTimeEvent> | null;
        if (oneTime?.name === 'one-time' && isOneTimeState(oneTime.state)) {
          markOneTimeServing(oneTimeServing(oneTime.state));
        }
      }
    },
    relay: bakedRelay(),
    // A Hosted sign-in hands managed voice its token; sign-out clears it, in
    // `SecretStorage`, which every window hears.
    voiceCredential: bakedRelay().mode === 'hosted' ? bound.voiceCredential?.() : undefined,
    // Building the factory loads nothing: the addon is opened inside the first
    // offer, if one ever comes (`native-direct-peer.ts`).
    createDirectPeer: createNativeDirectPeerFactory(),
  });
  void service.start().catch((error: unknown) => {
    log.error(`[burrow] failed to start: ${String(error)}`);
  });
}

/**
 * Whether this window has joined the contention at all. Until it has there is
 * no role coming and nothing for a command to wait for, so
 * {@link handleBurrowCommand} refuses rather than holds — which is the
 * honest answer on a machine that never enrolled.
 */
let contending = false;

/**
 * Join the contention for the Burrow and start serving if this window wins it.
 * Idempotent.
 */
function contendForBurrow(): void {
  contending = true;
  // Drained on the settle *and* on a contention that can never settle — no
  // storage location, or a link already disposed — because neither of those
  // sends a settle notification. A held command (an `enroll` included) would
  // otherwise wait out its whole budget for a role that is not coming.
  void ensurePeerNet((broker) => {
    if (broker) startService();
  }).then(drainQueuedCommands, drainQueuedCommands);
}

/**
 * Every settle drains, not just the first: a broker window closing sends every
 * survivor back into the contention, and the second or third role this window
 * takes has to pick up whatever arrived during that race.
 */
onPeerLinkSettled(() => drainQueuedCommands());

/**
 * Which window is owed each in-flight answer, for the commands that came over
 * the link. A `burrowRequestId` is minted with a per-adapter random tag, so it is unique
 * across every window and needs no second correlation id of its own.
 *
 * Only the broker ever has entries: a client window forwards rather than runs.
 */
const commandRoutes = new Map<string, PeerLinkClient>();

const NO_BURROW = 'no Burrow is reachable';

/**
 * Deliver one result to whoever is owed it — the one window that forwarded the
 * command, or this window's webviews when nothing forwarded it.
 *
 * A result is never sent both ways. `burrowRequestId`s are globally unique, so a broadcast
 * of another window's answer would settle nothing anywhere and would put that
 * window's Burrow state in front of webviews that never asked.
 */
function answer(payload: BurrowResult): void {
  const from = commandRoutes.get(payload.burrowRequestId);
  if (from) {
    commandRoutes.delete(payload.burrowRequestId);
    sendCommandResult(from, payload);
    return;
  }
  deps?.broadcastToWebviews({ type: 'burrow:result', payload });
}

/**
 * Commands that arrived while the contention was still running, oldest first.
 *
 * Bounded, because a console hook or a dialog can keep asking and a contention
 * that never settles must not grow this without limit. Each carries its own
 * deadline, derived from the asking adapter's rather than picked: a command the
 * settle never drains has to be refused *before* that adapter gives up, or the
 * webview sees a bare timeout where it could have seen a reason.
 */
const queued: Array<{ payload: BurrowCommand; timer: ReturnType<typeof setTimeout> }> = [];
const QUEUE_LIMIT = 12;
const QUEUE_BUDGET_MS = BURROW_COMMAND_TIMEOUT_MS - 1_000;

function enqueueCommand(payload: BurrowCommand): void {
  // At the limit the oldest goes: its asker has waited longest and is nearest
  // to timing out anyway, so a reason reaches it while it can still be read.
  if (queued.length >= QUEUE_LIMIT) dropQueued(queued[0]!.payload.burrowRequestId);
  const timer = setTimeout(() => dropQueued(payload.burrowRequestId), QUEUE_BUDGET_MS);
  queued.push({ payload, timer });
}

/** Take one command out of the queue and refuse it. */
function dropQueued(burrowRequestId: string): void {
  const index = queued.findIndex((entry) => entry.payload.burrowRequestId === burrowRequestId);
  if (index === -1) return;
  clearTimeout(queued[index]!.timer);
  queued.splice(index, 1);
  refuse(burrowRequestId);
}

/** A role settled: every held command now has somewhere to go. */
function drainQueuedCommands(): void {
  const pending = queued.splice(0);
  for (const { payload, timer } of pending) {
    clearTimeout(timer);
    if (service) void service.handleCommand(payload);
    else if (!forwardCommand(payload)) refuseCommand(payload);
  }
}

/** The commands that bootstrap an installation with no Burrow; see {@link handleBurrowCommand}. */
const CONTENTION_STARTERS: ReadonlySet<string> = new Set([
  'enroll',
  'enrollOffer',
  'beginHostedEnrollment',
  'oneTimeOpen',
  'setNetworkPolicy',
]);

/**
 * Hand one of this window's webview commands to the Burrow.
 *
 * The broker runs it; every other window forwards it over the link and gets the
 * broker's answer back as a `burrow:result` like any other.
 *
 * One rule covers the rest: while this window is contending and unsettled it
 * has neither, so the command is held and drained on the next settle rather
 * than refused. That is the state at activation, when the contention costs a
 * bind and a handshake, *and* the second or two after a broker window closes
 * and every survivor races for the socket — and refusing in either would tell
 * an enrolled machine's webview it has no Burrow moments before it gets one,
 * leaving the gates that arm on that answer down.
 *
 * `enroll`, `enrollOffer`, `beginHostedEnrollment`, `oneTimeOpen`, and
 * `setNetworkPolicy` are the commands that may start the contention: they are
 * how an installation with no Burrow at all bootstraps — `enrollOffer` from the
 * one-click card an idle `status` advertises ({@link idleStatus}),
 * `beginHostedEnrollment` from a Hosted build's enroll button, whose service
 * then polls the approval, `oneTimeOpen` from the idle
 * one-time panel, which needs no enrollment, and `setNetworkPolicy` because the
 * service is the policy's only writer: a window writing it with a service
 * elsewhere would leave that service holding the old one. Everything else
 * refuses only where there is genuinely nothing to reach — never contending, or
 * settled with no service and no broker.
 */
export function handleBurrowCommand(payload: BurrowCommand | undefined): void {
  if (!isBurrowCommand(payload)) return;
  if (service) {
    void service.handleCommand(payload);
    return;
  }
  if (forwardCommand(payload)) return;
  if (CONTENTION_STARTERS.has(payload.cmd)) {
    // Held rather than run inline once the contention settles: if some other
    // window enrolled first, this window is a client and the command belongs
    // on the link, which is exactly what the drain does.
    enqueueCommand(payload);
    contendForBurrow();
    return;
  }
  if (contending && !isPeerLinkSettled()) {
    enqueueCommand(payload);
    return;
  }
  refuseCommand(payload);
}

/**
 * Run a command another window forwarded, and remember to answer it there.
 *
 * The route is dropped by {@link dropForwardedCommands} if that window
 * disconnects first, which leaves the command unanswered on purpose: the socket
 * that would carry the answer is gone, and the asking adapter's own timeout is
 * the backstop.
 */
export function handleForwardedCommand(
  payload: BurrowCommand | undefined,
  from: PeerLinkClient,
): void {
  if (!isBurrowCommand(payload)) return;
  commandRoutes.set(payload.burrowRequestId, from);
  // Only a window that bound the socket is sent one of these, and binding is
  // what starts the service — but if there is somehow none, say so rather than
  // leave the asking webview to wait out its timeout.
  if (service) void service.handleCommand(payload);
  else answer({ burrowRequestId: payload.burrowRequestId, error: NO_BURROW });
}

/** That window is gone; its outstanding commands can never be answered. */
export function dropForwardedCommands(from: PeerLinkClient): void {
  for (const [burrowRequestId, owner] of commandRoutes) {
    if (owner === from) commandRoutes.delete(burrowRequestId);
  }
}

/** The broker answered a command this window forwarded. */
export function deliverCommandResult(payload: BurrowResult): void {
  deps?.broadcastToWebviews({ type: 'burrow:result', payload });
}

/** A Burrow UI event from the broker, for this window's webviews. */
export function deliverUiEvent(payload: unknown): void {
  deps?.broadcastToWebviews({ type: 'burrow:event', payload });
}

/**
 * One due alarm push from this window's alert host (`docs/specs/alert.md` ->
 * Push notifications): sent by this window's service, or handed to the
 * broker's over the link. Fire and forget, with no answer route: nothing
 * waits on it. Dropped when there is neither, never queued for a role that
 * may yet settle, because stale alarms are never retried.
 */
export function pushAlert(sessionId: string, title: string): void {
  if (service) void service.push(sessionId, title);
  else forwardPush(sessionId, title);
}

/** Broker side: a push another window's alert host forwarded. Never
 *  forwarded again. */
export function handleForwardedPush(sessionId: string, title: string): void {
  void service?.push(sessionId, title);
}

/**
 * A window just joined this broker. Hand it the Burrow state its webviews gate
 * themselves on.
 *
 * Without this a window that opened after the enrollment is told nothing:
 * `status` events are emitted on change, and nothing about the Burrow changes
 * because a window connected. Its webviews would sit disarmed — announcing no
 * directory changes, seeding no pairing queue — until the user reloaded the
 * whole window (`lib/src/remote/burrow/enrolled-gate.ts`).
 */
export function greetPeerWindow(client: PeerLinkClient): void {
  if (!service) return;
  sendUiEvent(client, service.statusEvent());
  // And the one-time panel's state, which changes as rarely and matters as much
  // to a window whose Settings may be showing it.
  sendUiEvent(client, service.oneTimeEvent());
}

function refuse(burrowRequestId: string): void {
  deps?.broadcastToWebviews({ type: 'burrow:result', payload: { burrowRequestId, error: NO_BURROW } });
}

/**
 * What an idle service answers, for the read-only commands a window with no
 * Burrow at all is still asked. `status` reads the offer file
 * ({@link idleStatus}); `oneTimeStatus` and `networkPolicy` read the network
 * policy through the same reader the service uses, so the two cannot drift —
 * and never save its default, which is the service's to write.
 *
 * Reaching the refusal below means this window sees no enrollment — it contends
 * at activation when there is one, and again the moment another window writes
 * one (`burrowStateStore`) — so "there is no Burrow" is the ordinary un-enrolled
 * state, not a failure. Erroring for it broke the contract each caller reads:
 * `pushDevices` answers `null` for "nowhere to push" and a rejection for "the
 * Relay could not be asked", so the Settings dialog was reporting an
 * unreachable Relay on a machine that had simply never enrolled
 * (`lib/src/lib/push-devices.ts`), and `enrolled-gate.ts` seeds from `status`.
 * The sidecar has no such path — it always has a service — so these are exactly
 * what one with no enrollment returns (`lib/src/host/remote/service.ts`). The
 * one-time pair is the same: no service means no connection, so its status is
 * the idle one this build's origin and policy allow, and ending it is already
 * done; a Hosted enrollment is polled by a service, so with none there is
 * nothing to cancel; and with no service there is no session to take a pane
 * back from.
 */
async function idleAnswer(cmd: string): Promise<{ result: unknown } | null> {
  switch (cmd) {
    case 'status':
      return { result: await idleStatus() };
    case 'pushDevices':
      return { result: null satisfies PushDevicesResult };
    case 'pairingQueue':
      return { result: [] satisfies PairingQueueItem[] };
    // A policy that cannot be read offers no link, as the service's own
    // `#level` reads it.
    case 'oneTimeStatus': {
      const level = await idleNetworkPolicy().then(
        (policy) => policy.level,
        () => 'nothing' as const,
      );
      return { result: idleOneTimeState(hostedOrigin(bakedRelay()), level) };
    }
    // With no service there is no session for the path to have ended.
    case 'networkPolicy':
    case 'dismissPathRefusal':
      return {
        result: networkPolicyResult(await idleNetworkPolicy(), bakedRelay().mode, listNetworkInterfaces()),
      };
    case 'oneTimeEnd':
    // Nor an enrollment awaiting approval: the service that began one holds it.
    case 'cancelHostedEnrollment':
      return { result: {} };
    // No service holds any session, so none holds a pane: the strip clears itself.
    case 'takeBack':
      return { result: { ended: false } satisfies TakeBackResult };
    default:
      return null;
  }
}

/**
 * Whether the network policy lets this window reach Hosted on its own, for
 * managed voice: the service's answer in the broker, else the policy every
 * window reads from `globalState`, which only the service writes.
 */
export async function burrowNetworkAllowed(): Promise<boolean> {
  if (service) return service.networkAllowed();
  try {
    return (await idleNetworkPolicy()).level !== 'nothing';
  } catch {
    // A failed read counts as Nothing, as it does for the service.
    return false;
  }
}

/** The network policy as a service starting now would read it, the default unsaved. */
async function idleNetworkPolicy(): Promise<NetworkPolicy> {
  if (!context) throw new Error(NO_BURROW);
  return (await peekNetworkPolicyFor(burrowStateStore(context), bakedRelay())).policy;
}

/**
 * The idle `status` — the one that has to look at the disk.
 *
 * This process is the same kind of process the service runs in, so it can read
 * the installer's offer itself (`lib/src/host/remote/enroll-offer.ts`) and
 * answer exactly what a service with nothing in its store would. Without that,
 * a machine that has never enrolled — which is precisely where the one-click
 * card belongs — would be told there is no offer and never render it. A file
 * read is not a socket, so "a user who never enrolls never sees a socket"
 * (`docs/specs/vscode.md`) still holds, and pressing Enroll runs `enrollOffer`,
 * which bootstraps the contention like `enroll`.
 */
async function idleStatus(): Promise<BurrowConsoleStatus> {
  // The reader and the snapshot are the service's own, so the two answers to
  // the same question cannot drift. `readEnrollmentOffer` never rejects (its own
  // doc), hence no guard here.
  const relay = bakedRelay();
  return unenrolledStatus(await readUsableOffer(relay, readEnrollmentOffer), 'vscode', relay);
}

/** Refuse one command — or answer it as an idle service would ({@link idleAnswer}). */
function refuseCommand(payload: BurrowCommand): void {
  // This is the extension host: an unhandled rejection here is a crash, so a
  // read that fails gets the ordinary refusal.
  void idleAnswer(payload.cmd).then(
    (idle) => (idle ? answerIdle(payload.burrowRequestId, idle.result) : refuse(payload.burrowRequestId)),
    () => refuse(payload.burrowRequestId),
  );
}

function answerIdle(burrowRequestId: string, result: unknown): void {
  deps?.broadcastToWebviews({ type: 'burrow:result', payload: { burrowRequestId, result } });
}

/**
 * Give the Burrow its storage and start it if this installation is already
 * enrolled, or another window's one-time connection is serving. Nothing
 * contends for the socket otherwise — see `docs/specs/vscode.md` → "Burrow: a
 * service in the extension host".
 */
export function initBurrow(ctx: vscode.ExtensionContext): vscode.Disposable {
  context = ctx;
  void contendIfServing(ctx);

  return {
    dispose() {
      service?.dispose();
      service = null;
      // The service ends its one-time connection unannounced, so a mark this
      // window set would outlive it. Only its own: a window that never served
      // must not clear the broker's.
      if (servingMarked) markOneTimeServing(false);
      // After the service; only here (`docs/specs/vscode.md` → "The direct path").
      disposeNativeDirectPeers();
      askProvider = null;
      contending = false;
      servingMarked = null;
      commandRoutes.clear();
      for (const { timer } of queued.splice(0)) clearTimeout(timer);
      store?.dispose();
      store = null;
      context = null;
    },
  };
}

/**
 * Contend when there is something to serve: an enrollment, or another window's
 * one-time connection (`ONE_TIME_SERVING_KEY`), whose phone should see this
 * window's terminals too. Each read stands alone, so a keychain that refuses
 * one still lets the other decide. A window already contending has nothing
 * left to learn from either: contention is never withdrawn.
 */
async function contendIfServing(ctx: vscode.ExtensionContext): Promise<void> {
  const store = burrowStateStore(ctx);
  if (contending) return;
  const [enrollment, serving] = await Promise.allSettled([
    loadEnrollmentFor(store, bakedRelay().origin),
    store.loadOneTimeServing(),
  ]);
  if (enrollment.status === 'rejected') {
    log.error(`[burrow] could not read the enrollment: ${String(enrollment.reason)}`);
  }
  if (serving.status === 'rejected') {
    log.error(`[burrow] could not read the one-time serving marker: ${String(serving.reason)}`);
  }
  if (
    (enrollment.status === 'fulfilled' && enrollment.value) ||
    (serving.status === 'fulfilled' && serving.value)
  ) {
    contendForBurrow();
  }
}

/**
 * The window's one store, made on first use.
 *
 * It reports enrollment and serving-marker writes from *any* window of this
 * extension, which is the only signal a window that was un-enrolled at
 * activation ever gets: it never contended, so it has no socket and no broker
 * to hear from. Re-checking here is what lets a second window join the Burrow a
 * first one just enrolled, or the one-time connection it just opened, without
 * a reload.
 */
function burrowStateStore(ctx: vscode.ExtensionContext): VsCodeBurrowStateStore {
  store ??= new VsCodeBurrowStateStore(ctx, () => {
    void contendIfServing(ctx);
  });
  return store;
}

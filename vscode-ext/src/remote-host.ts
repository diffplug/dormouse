/**
 * The VS Code extension host's binding of {@link RemoteHostService}.
 *
 * The extension host owns the PTYs, so the Host lives here rather than in a
 * webview: the relay socket, the enrollment, the ACL, and the pairing ceremony
 * are all outside any webview realm, and a webview can only answer what its own
 * panes are called and how big they are (docs/specs/remote-security-model.md).
 *
 * One extension host runs per window, so exactly one window may hold it. That
 * arbitration is `peer-link.ts`'s bind-as-lease; this module starts the service
 * only in the window that won. A losing window runs no service at all: its
 * webviews' commands are forwarded over the link and the broker's answers come
 * back the same way, so the Host behaves identically in every window while
 * existing in exactly one.
 *
 * Nothing here runs until there is a Host to run: contention starts when an
 * enrollment already exists, or on the first `enroll` command. A user who never
 * enrolls never sees a socket.
 */

import type * as vscode from 'vscode';

import {
  createAskSurfaceProvider,
  type AskSurfaceProvider,
} from '../../lib/src/host/remote/ask-surface-provider';
import { bakedConnectSrc } from '../../lib/src/host/remote/connect-src';
import { REMOTE_HOST_COMMAND_TIMEOUT_MS } from '../../lib/src/host/remote/link-client';
import { RemoteHostService } from '../../lib/src/host/remote/service';
import {
  REMOTE_HOST_EVENT_EVENT,
  REMOTE_HOST_RESULT_EVENT,
  isRemoteHostCommand,
  type PairingQueueItem,
  type PushDevicesResult,
  type RemoteHostCommand,
  type RemoteHostConsoleStatus,
  type RemoteHostResult,
} from '../../lib/src/host/remote/service-protocol';
import type { HostSurfaceProvider } from '../../lib/src/remote/host/host-surface-provider';
import type {
  PeerSurfaceParams,
  PeerSurfaceResult,
} from '../../lib/src/remote/host/peer-surfaces';
import type { WebSocketLike } from '../../lib/src/remote/host/remote-host';
import type { ExtensionMessage } from './message-types';
import {
  broadcastUiEvent,
  ensurePeerNet,
  forwardCommand,
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
import { VsCodeHostStateStore } from './remote-host-store';
import { log } from './log';

/**
 * What this module needs from the router, injected rather than imported: the
 * router routes commands here, so importing back would be a cycle.
 */
export interface RemoteHostDeps {
  /** Fan one question out to this window's webviews and collect the answers. */
  brokerRequest(op: string, params: unknown): Promise<unknown[]>;
  /** Post to every live webview in this window. */
  broadcastToWebviews(message: ExtensionMessage): void;
  writePty(ptyId: string, data: string): void;
  resizePty(ptyId: string, cols: number, rows: number): void;
  /**
   * Watch one PTY this window owns, through the window's shared keyed registry
   * (`processed-pty-streams.ts`) rather than a listener pair per attachment.
   */
  streamPty(ptyId: string, sink: PtySink): () => void;
}

let deps: RemoteHostDeps | null = null;

export function configureRemoteHost(next: RemoteHostDeps): void {
  deps = next;
}

let context: vscode.ExtensionContext | null = null;
/**
 * One store for the window: `SecretStorage` is a keychain round trip, and the
 * activation probe and the service would otherwise each pay for their own.
 */
let store: VsCodeHostStateStore | null = null;
let service: RemoteHostService | null = null;
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
  bound: RemoteHostDeps,
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
export function createRemoteHostProvider(bound: RemoteHostDeps): HostSurfaceProvider {
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
      resizePty: (ptyId, cols, rows) => {
        if (isRemotePtyHandle(ptyId)) {
          remoteResize(ptyId, cols, rows);
          return;
        }
        bound.resizePty(ptyId, cols, rows);
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
 * `^1.85.0` — VS Code 1.85 shipped Electron 25 / Node 18, and the supported
 * range spans the boundary — so on an older host there is no global to use and
 * the bundled `ws` is the only implementation. Its socket satisfies the same
 * surface `RemoteHost` reads and nothing more: `send`, `close`, `readyState`,
 * `addEventListener`, with `message` events carrying `.data` and `close` events
 * carrying `.code`.
 *
 * `ws`'s optional native accelerators (`bufferutil`, `utf-8-validate`) are
 * deliberately left unbundled and unshipped; `ws` falls back to its JS paths.
 */
export function createRelaySocket(url: string): WebSocketLike {
  const Impl = globalThis.WebSocket ?? (require('ws') as typeof import('ws')).WebSocket;
  return new Impl(url) as unknown as WebSocketLike;
}

function startService(): void {
  if (service || !context || !deps) return;
  const bound = deps;
  service = new RemoteHostService({
    store: hostStateStore(context),
    provider: createRemoteHostProvider(bound),
    createWebSocket: createRelaySocket,
    sendToUi: (event, data) => {
      if (event === REMOTE_HOST_RESULT_EVENT) {
        answer(data as RemoteHostResult);
      } else if (event === REMOTE_HOST_EVENT_EVENT) {
        // Every window, not just this one: the pairing modal can be answered
        // from whichever webview the user happens to be looking at, and only
        // the windows that see the queue can show one.
        bound.broadcastToWebviews({ type: 'remoteHost:event', payload: data });
        broadcastUiEvent(data);
      }
    },
    connectSrc: bakedConnectSrc(),
  });
  void service.start().catch((error: unknown) => {
    log.error(`[remote-host] failed to start: ${String(error)}`);
  });
}

/**
 * Whether this window has joined the contention at all. Until it has there is
 * no role coming and nothing for a command to wait for, so
 * {@link handleRemoteHostCommand} refuses rather than holds — which is the
 * honest answer on a machine that never enrolled.
 */
let contending = false;

/**
 * Join the contention for the Host and start serving if this window wins it.
 * Idempotent.
 */
function contendForHost(): void {
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
 * the link. An `rhId` is minted with a per-adapter random tag, so it is unique
 * across every window and needs no second correlation id of its own.
 *
 * Only the broker ever has entries: a client window forwards rather than runs.
 */
const commandRoutes = new Map<string, PeerLinkClient>();

const NO_HOST = 'no remote Host is reachable';

/**
 * Deliver one result to whoever is owed it — the one window that forwarded the
 * command, or this window's webviews when nothing forwarded it.
 *
 * A result is never sent both ways. `rhId`s are globally unique, so a broadcast
 * of another window's answer would settle nothing anywhere and would put that
 * window's Host state in front of webviews that never asked.
 */
function answer(payload: RemoteHostResult): void {
  const from = commandRoutes.get(payload.rhId);
  if (from) {
    commandRoutes.delete(payload.rhId);
    sendCommandResult(from, payload);
    return;
  }
  deps?.broadcastToWebviews({ type: 'remoteHost:result', payload });
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
const queued: Array<{ payload: RemoteHostCommand; timer: ReturnType<typeof setTimeout> }> = [];
const QUEUE_LIMIT = 12;
const QUEUE_BUDGET_MS = REMOTE_HOST_COMMAND_TIMEOUT_MS - 1_000;

function enqueueCommand(payload: RemoteHostCommand): void {
  // At the limit the oldest goes: its asker has waited longest and is nearest
  // to timing out anyway, so a reason reaches it while it can still be read.
  if (queued.length >= QUEUE_LIMIT) dropQueued(queued[0]!.payload.rhId);
  const timer = setTimeout(() => dropQueued(payload.rhId), QUEUE_BUDGET_MS);
  queued.push({ payload, timer });
}

/** Take one command out of the queue and refuse it. */
function dropQueued(rhId: string): void {
  const index = queued.findIndex((entry) => entry.payload.rhId === rhId);
  if (index === -1) return;
  clearTimeout(queued[index]!.timer);
  queued.splice(index, 1);
  refuse(rhId);
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

/**
 * Hand one of this window's webview commands to the Host.
 *
 * The broker runs it; every other window forwards it over the link and gets the
 * broker's answer back as a `remoteHost:result` like any other.
 *
 * One rule covers the rest: while this window is contending and unsettled it
 * has neither, so the command is held and drained on the next settle rather
 * than refused. That is the state at activation, when the contention costs a
 * bind and a handshake, *and* the second or two after a broker window closes
 * and every survivor races for the socket — and refusing in either would tell
 * an enrolled machine's webview it has no Host moments before it gets one,
 * leaving the gates that arm on that answer down.
 *
 * `enroll` is the one command that may start the contention: it is how an
 * installation with no Host at all bootstraps. Everything else refuses only
 * where there is genuinely nothing to reach — never contending, or settled with
 * no service and no broker.
 */
export function handleRemoteHostCommand(payload: RemoteHostCommand | undefined): void {
  if (!isRemoteHostCommand(payload)) return;
  if (service) {
    void service.handleCommand(payload);
    return;
  }
  if (forwardCommand(payload)) return;
  if (payload.cmd === 'enroll') {
    // Held rather than run inline once the contention settles: if some other
    // window enrolled first, this window is a client and the command belongs
    // on the link, which is exactly what the drain does.
    enqueueCommand(payload);
    contendForHost();
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
  payload: RemoteHostCommand | undefined,
  from: PeerLinkClient,
): void {
  if (!isRemoteHostCommand(payload)) return;
  commandRoutes.set(payload.rhId, from);
  // Only a window that bound the socket is sent one of these, and binding is
  // what starts the service — but if there is somehow none, say so rather than
  // leave the asking webview to wait out its timeout.
  if (service) void service.handleCommand(payload);
  else answer({ rhId: payload.rhId, error: NO_HOST });
}

/** That window is gone; its outstanding commands can never be answered. */
export function dropForwardedCommands(from: PeerLinkClient): void {
  for (const [rhId, owner] of commandRoutes) {
    if (owner === from) commandRoutes.delete(rhId);
  }
}

/** The broker answered a command this window forwarded. */
export function deliverCommandResult(payload: RemoteHostResult): void {
  deps?.broadcastToWebviews({ type: 'remoteHost:result', payload });
}

/** A Host UI event from the broker, for this window's webviews. */
export function deliverUiEvent(payload: unknown): void {
  deps?.broadcastToWebviews({ type: 'remoteHost:event', payload });
}

/**
 * A window just joined this broker. Hand it the Host state its webviews gate
 * themselves on.
 *
 * Without this a window that opened after the enrollment is told nothing:
 * `status` events are emitted on change, and nothing about the Host changes
 * because a window connected. Its webviews would sit disarmed — announcing no
 * directory changes, watching for no rings — until the user reloaded the whole
 * window (`lib/src/remote/host/enrolled-gate.ts`).
 */
export function greetPeerWindow(client: PeerLinkClient): void {
  if (!service) return;
  sendUiEvent(client, service.statusEvent());
}

function refuse(rhId: string): void {
  deps?.broadcastToWebviews({ type: 'remoteHost:result', payload: { rhId, error: NO_HOST } });
}

/**
 * What an idle service answers, for the read-only commands a window with no
 * Host at all is still asked.
 *
 * Reaching the refusal below means this window sees no enrollment — it contends
 * at activation when there is one, and again the moment another window writes
 * one (`hostStateStore`) — so "there is no Host" is the ordinary un-enrolled
 * state, not a failure. Erroring for it broke the contract each caller reads:
 * `pushDevices` answers `null` for "nowhere to push" and a rejection for "the
 * server could not be asked", so the Settings dialog was reporting an
 * unreachable server on a machine that had simply never enrolled
 * (`lib/src/lib/push-devices.ts`), and `enrolled-gate.ts` seeds from `status`.
 * The sidecar has no such path — it always has a service — so these are exactly
 * what one with no enrollment returns (`lib/src/host/remote/service.ts`).
 */
function idleAnswer(cmd: string): { result: unknown } | null {
  switch (cmd) {
    case 'status':
      return {
        result: {
          enrolled: false,
          serverUrl: null,
          hostId: null,
          connection: 'stopped',
          pairedClients: 0,
        } satisfies RemoteHostConsoleStatus,
      };
    case 'pushDevices':
      return { result: null satisfies PushDevicesResult };
    case 'pairingQueue':
      return { result: [] satisfies PairingQueueItem[] };
    default:
      return null;
  }
}

/** Refuse one command — or answer it as an idle service would ({@link idleAnswer}). */
function refuseCommand(payload: RemoteHostCommand): void {
  const idle = idleAnswer(payload.cmd);
  if (!idle) {
    refuse(payload.rhId);
    return;
  }
  deps?.broadcastToWebviews({
    type: 'remoteHost:result',
    payload: { rhId: payload.rhId, result: idle.result },
  });
}

/**
 * Give the Host its storage and start it if this installation is already
 * enrolled. Nothing contends for the socket otherwise — see the module header.
 */
export function initRemoteHost(ctx: vscode.ExtensionContext): vscode.Disposable {
  context = ctx;
  void contendIfEnrolled(ctx);

  return {
    dispose() {
      service?.dispose();
      service = null;
      askProvider = null;
      contending = false;
      commandRoutes.clear();
      for (const { timer } of queued.splice(0)) clearTimeout(timer);
      store?.dispose();
      store = null;
      context = null;
    },
  };
}

function contendIfEnrolled(ctx: vscode.ExtensionContext): Promise<void> {
  return hostStateStore(ctx)
    .loadEnrollment()
    .then((enrollment) => {
      if (enrollment) contendForHost();
    })
    .catch((error: unknown) => {
      log.error(`[remote-host] could not read the enrollment: ${String(error)}`);
    });
}

/**
 * The window's one store, made on first use.
 *
 * It reports enrollment writes from *any* window of this extension, which is
 * the only signal a window that was un-enrolled at activation ever gets: it
 * never contended, so it has no socket and no broker to hear from. Re-checking
 * here is what lets a second window join the Host a first one just enrolled,
 * without a reload.
 */
function hostStateStore(ctx: vscode.ExtensionContext): VsCodeHostStateStore {
  store ??= new VsCodeHostStateStore(ctx, () => {
    void contendIfEnrolled(ctx);
  });
  return store;
}

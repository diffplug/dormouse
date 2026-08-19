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
  type RemoteHostCommand,
  type RemoteHostResult,
} from '../../lib/src/host/remote/service-protocol';
import type { HostSurfaceProvider, PtySink } from '../../lib/src/remote/host/host-surface-provider';
import type { WebSocketLike } from '../../lib/src/remote/host/remote-host';
import type { ExtensionMessage } from './message-types';
import {
  broadcastUiEvent,
  ensurePeerNet,
  forwardCommand,
  isRemotePty,
  remoteRequest,
  remoteResize,
  remoteSubscribe,
  remoteUnsubscribe,
  remoteWrite,
  sendCommandResult,
  sendUiEvent,
  type PeerLinkClient,
} from './peer-link';
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
  onProcessedPtyData(listener: (id: string, data: string) => void): () => void;
  onProcessedPtyExit(listener: (id: string, exitCode: number) => void): () => void;
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
 * webviews first.
 *
 * Both at once rather than the near tier first: whatever is asked about lives
 * in exactly one webview of one window, so asking in series would spend a whole
 * tier's budget before the window that actually owns it is even asked. The
 * results carry no tier marker because nothing downstream needs one — a
 * directory is a concatenation, and a surface id is unique across every window.
 */
async function askBothTiers(
  bound: RemoteHostDeps,
  op: string,
  params: unknown,
): Promise<unknown[]> {
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
  askProvider = createAskSurfaceProvider((op, params) => askBothTiers(bound, op, params), {
    // The link takes only a PTY it has a route for, and a route is placed only
    // by an attach another window answered — so a PTY of this window's own can
    // never be taken out from under the manager that owns it.
    writePty: (ptyId, data) => {
      if (!remoteWrite(ptyId, data)) bound.writePty(ptyId, data);
    },
    resizePty: (ptyId, cols, rows) => {
      if (!remoteResize(ptyId, cols, rows)) bound.resizePty(ptyId, cols, rows);
    },

    streamPty(ptyId, sink) {
      if (isRemotePty(ptyId)) {
        // Another window's terminal: it has already stripped the protocol out
        // on its side, so what arrives over the link is what its own xterm
        // renders — the same stream shape as the local branch below.
        remoteSubscribe(ptyId, sink);
        return () => remoteUnsubscribe(ptyId, sink);
      }
      return streamLocalPty(bound, ptyId, sink);
    },
  });
  return askProvider.provider;
}

/** Sinks on this window's own PTYs, keyed by the id they are watching. */
const localStreams = new Map<string, Set<PtySink>>();
let stopLocalListeners: (() => void) | null = null;

/**
 * Stream a PTY this window owns, through one listener pair for the whole window
 * rather than one per attachment: these run on every chunk of every terminal in
 * the window, so a listener per attachment would tax every keystroke of every
 * PTY once per attached surface.
 *
 * No strip parser here, unlike the sidecar: this process already runs the
 * terminal-protocol parser once per chunk and answers its queries, and
 * `onProcessedPtyData` is what comes out the other side. A second parser would
 * answer every query twice and corrupt the PTY.
 */
function streamLocalPty(bound: RemoteHostDeps, ptyId: string, sink: PtySink): () => void {
  let sinks = localStreams.get(ptyId);
  if (!sinks) {
    sinks = new Set();
    localStreams.set(ptyId, sinks);
  }
  const subscribed = sinks;
  subscribed.add(sink);

  if (!stopLocalListeners) {
    const offData = bound.onProcessedPtyData((id, data) => {
      const targets = localStreams.get(id);
      if (!targets) return;
      for (const target of targets) target.onData(data);
    });
    const offExit = bound.onProcessedPtyExit((id, exitCode) => {
      const targets = localStreams.get(id);
      if (!targets) return;
      // Iterated live rather than copied: an exit tears its own attachment
      // down, which a Set tolerates mid-iteration.
      for (const target of targets) target.onExit(exitCode);
    });
    stopLocalListeners = () => {
      offData();
      offExit();
    };
  }

  return () => {
    subscribed.delete(sink);
    if (subscribed.size > 0) return;
    localStreams.delete(ptyId);
    // Nothing attached: back to costing this window's terminals nothing.
    if (localStreams.size > 0) return;
    stopLocalListeners?.();
    stopLocalListeners = null;
  };
}

/**
 * Something a future directory answer could depend on changed: a pane, an
 * alert, a webview, a peer window. `topic` is a webview's own word for what
 * changed; a change with no topic is always the directory's business.
 */
export function notifyDirectoryChanged(topic?: string | null): void {
  askProvider?.notifyDirectoryChanged(topic);
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
 * Whether a contention is running right now. While it is, this window is
 * neither a broker nor a client: {@link handleRemoteHostCommand} holds commands
 * instead of refusing them, because a refusal here is indistinguishable to the
 * caller from "this machine has no Host at all".
 */
let settling: Promise<void> | null = null;

/**
 * Join the contention for the Host and start serving if this window wins it.
 * Idempotent; resolves once a role is settled.
 */
function contendForHost(): Promise<void> {
  settling ??= ensurePeerNet((broker) => {
    if (broker) startService();
  }).then(
    () => {
      settling = null;
      drainQueuedCommands();
    },
    (error: unknown) => {
      settling = null;
      log.error(`[remote-host] contention failed: ${String(error)}`);
      drainQueuedCommands();
    },
  );
  return settling;
}

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
    else if (!forwardCommand(payload)) refuse(payload.rhId);
  }
}

/**
 * Hand one of this window's webview commands to the Host.
 *
 * The broker runs it; every other window forwards it over the link and gets the
 * broker's answer back as a `remoteHost:result` like any other.
 *
 * A window that is still contending has neither yet, and the contention takes
 * as long as a bind and a handshake — so the command is held and drained when a
 * role settles rather than refused. Refusing then would tell an enrolled
 * machine's webview that it has no Host, seconds before it gets one, and the
 * gates that arm on that answer would stay down.
 *
 * `enroll` is the one command that may start the contention: it is how an
 * installation with no Host at all bootstraps. Everything else refuses only
 * where there is genuinely nothing to reach — nothing contending, no service,
 * no broker.
 */
export function handleRemoteHostCommand(payload: RemoteHostCommand | undefined): void {
  if (!isCommand(payload)) return;
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
    void contendForHost();
    return;
  }
  if (settling) {
    enqueueCommand(payload);
    return;
  }
  refuse(payload.rhId);
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
  if (!isCommand(payload)) return;
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

function isCommand(payload: RemoteHostCommand | undefined): payload is RemoteHostCommand {
  return !!payload && typeof payload.rhId === 'string' && typeof payload.cmd === 'string';
}

function refuse(rhId: string): void {
  deps?.broadcastToWebviews({ type: 'remoteHost:result', payload: { rhId, error: NO_HOST } });
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
      if (enrollment) return contendForHost();
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

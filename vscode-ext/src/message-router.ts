import * as vscode from 'vscode';
import * as ptyManager from './pty-manager';
import { createAlertHost, type AlertRealm } from '../../lib/src/host/alert-host';
import { alertedPty, createOwnerPtyStream } from '../../lib/src/host/owner-pty';
import type {
  TerminalColorProvider,
  TerminalColors,
  TerminalProtocolEvent,
} from '../../lib/src/lib/terminal-protocol';
import type { ProcessedPtyChunk, ProcessedPtyStream } from '../../lib/src/lib/processed-pty-stream';
import { normalizeExternalUri } from '../../lib/src/lib/external-links';
import { VSCODE_WORKBENCH_COMMANDS } from '../../lib/src/lib/vscode-keybindings';
import { computeWorkspaceUnion, type WorkspaceUnion } from '../../lib/src/lib/workspace-union';
import type { ActivityState } from '../../lib/src/lib/session-activity-store';
import type { TerminalSemanticEvent } from '../../lib/src/lib/terminal-state';
import type { WebviewMessage, ExtensionMessage } from './message-types';
import type { DorControlRequest } from './pty-manager';
import { dorWorkspaceRefusal } from './dor-workspace-guard';
import { runBrowserRequest } from './agent-browser-host';
import { createIframeProxyUrl } from './iframe-proxy-host';
import { toolControl } from './tool-host';
import type { ToolHostRequest } from '../../lib/src/lib/platform/types';
import { ASK_BUDGET_MS } from '../../lib/src/host/remote/service-protocol';
import { configurePeerLink, remoteNotifyPeerChange } from './peer-link';
import { createProcessedPtyStreams } from './processed-pty-streams';
import {
  configureBurrow,
  deliverCommandResult,
  deliverUiEvent,
  dropForwardedCommands,
  greetPeerWindow,
  handleForwardedCommand,
  handleForwardedPush,
  handleBurrowCommand,
  notifyDirectoryChanged,
  pushAlert,
} from './burrow';
import { log } from './log';
import type { WebviewChannel } from './webview-messaging';

const clipboardOps = require('../../lib/clipboard-ops.cjs') as {
  readClipboardFilePaths(): Promise<string[]>;
  readClipboardImageAsFilePath(): Promise<string | null>;
};

// Global set of PTY IDs claimed by any router instance.
// Prevents reconnecting routers from stealing PTYs owned by other webviews.
const globalOwnedPtyIds = new Set<string>();

interface ActiveRouter {
  flushSessionSave(timeoutMs?: number): Promise<void>;
  ownsPty(id: string): boolean;
  forwardDorControlRequest(request: DorControlRequest): void;
  send(message: ExtensionMessage): void;
  ask(requestId: string, op: string, params: unknown): void;
}

let nextBrokerRequestId = 0;

interface PendingRequest {
  /** Answers still outstanding, so a miss settles as fast as a hit. */
  pending: Set<ActiveRouter>;
  results: unknown[];
  settle: () => void;
  timer: ReturnType<typeof setTimeout>;
}
const peerRequests = new Map<string, PendingRequest>();
const processedPtyStreams = createProcessedPtyStreams(
  subscribeProcessedPty,
  onProcessedPtyExit,
  ptyManager.getPtyStatus,
);

// The link reaches other windows; it must never call back into a fan-out that
// would reach them again, so it only ever gets the in-window broker.
configurePeerLink({
  brokerRequest,
  invalidateDirectory: notifyDirectoryChanged,
  streamPty: processedPtyStreams.streamPty,
  writePty: writeClientInput,
  resizePty: resizeForClient,
  // Peer PTYs use generated provider-local route handles. Keep those handles
  // outside this window's real PTY namespace so local ids always fall through
  // to the manager that owns them.
  ownsPty: (ptyId) => ptyManager.hasPty(ptyId) || globalOwnedPtyIds.has(ptyId),
  // The Burrow half: which of these fire depends on which side of the bind this
  // window landed on, and the link is what knows that.
  handleForwardedCommand,
  dropForwardedCommands,
  handleForwardedPush,
  deliverCommandResult,
  deliverUiEvent,
  onClientAuthenticated: greetPeerWindow,
});

configureBurrow({
  brokerRequest,
  broadcastToWebviews,
  streamPty: processedPtyStreams.streamPty,
  writePty: writeClientInput,
  resizePty: resizeForClient,
});

/**
 * A remote Client's input, reaching this window's PTY from its own Burrow or
 * over the peer link from the broker's.
 */
function writeClientInput(ptyId: string, data: string): void {
  alertedPtys.writeClientInput(ptyId, data);
}

function resizeForClient(ptyId: string, cols: number, rows: number, repaint?: boolean): void {
  alertedPtys.resize(ptyId, cols, rows, repaint);
}

/**
 * Put one question to every webview in this window and settle with everything
 * they answered.
 *
 * The Burrow runs in the extension host, but a window's terminals are
 * spread across its webviews — each has its own xterm registry, so the Burrow can
 * neither list nor attach to a pane without asking. See docs/specs/vscode.md →
 * "Peer surfaces".
 *
 * `op` and `params` are opaque here on purpose: the operation map lives in
 * `lib/src/remote/burrow/peer-surfaces.ts`, and one fan-out rule covers all of
 * it — every webview answers with zero or more results, so a webview that owns
 * nothing settles the request as fast as the one that does. The budget is the
 * backstop for a webview with no live content, which must not hang the phone's
 * picker; it is the *inner* one, deliberately shorter than the broker's
 * cross-window `PEER_REPLY_BUDGET_MS`, which has to contain a whole run of this
 * plus two socket hops. The asker is this window's own Burrow service, or the
 * broker window's over the link, never a webview; that is why it is a plain
 * promise rather than message plumbing.
 */
function brokerRequest(op: string, params: unknown): Promise<unknown[]> {
  const peers = [...activeRouters];
  if (peers.length === 0) return Promise.resolve([]);

  const requestId = `broker-${++nextBrokerRequestId}`;
  return new Promise((resolve) => {
    const settle = () => {
      const request = peerRequests.get(requestId);
      if (!request) return;
      peerRequests.delete(requestId);
      clearTimeout(request.timer);
      resolve(request.results);
    };
    peerRequests.set(requestId, {
      pending: new Set(peers),
      results: [],
      settle,
      timer: setTimeout(settle, ASK_BUDGET_MS),
    });
    for (const peer of peers) peer.ask(requestId, op, params);
  });
}

/**
 * Post one message to every live webview in this window.
 *
 * The Burrow's results ride this rather than a reply to one webview: the service
 * answers a `burrowRequestId`, and only the adapter that minted it holds a pending
 * command for it (`lib/src/lib/platform/vscode-adapter.ts`).
 */
function broadcastToWebviews(message: ExtensionMessage): void {
  for (const router of activeRouters) router.send(message);
}

const activeRouters = new Set<ActiveRouter>();
let nextFlushRequestId = 0;
/** Tags each router's engagement viewer in the shared alert manager. */
let nextRouterId = 0;
const ALLOWED_WORKBENCH_COMMANDS = new Set<string>(VSCODE_WORKBENCH_COMMANDS);

// This window's alerts, in the host role standalone's sidecar runs too
// (`lib/src/host/alert-host.ts`). They survive router disposal, so alert state
// persists across webview collapse/expand cycles; each router is one realm. A
// due push goes from here, whether or not a webview shows its Session.
const alertHost = createAlertHost({ push: pushAlert });
const alertManager = alertHost.manager;

/**
 * This VS Code window's state, as `activate` reports it. Focused and recently
 * active, the window is one more viewer — with no focus, so it engages no
 * Session — which holds back a push: the user may be working outside the
 * Dormouse webview (`docs/specs/alert.md` -> Alarm
 * settings). `WindowState.active` is finalized in 1.89, after the supported
 * 1.85; an older VS Code never reports it, and focus alone must not count, or
 * a focused window left behind would silence the walked-away channel.
 */
const WINDOW_VIEWER = 'vscode-window';
export function reportWindowPresence(state: vscode.WindowState): void {
  const active = (state as { active?: unknown }).active === true;
  alertManager.setViewer(WINDOW_VIEWER, { present: state.focused && active, focusId: null });
}
/** Every PTY write and resize, as the alerts must see it. */
const alertedPtys = alertedPty(alertManager, ptyManager);
/**
 * This window's parse sites: one per PTY generation, created at spawn and fed
 * every chunk from there, so the extension host answers each query once and both
 * projections reach every consumer (`docs/specs/terminal-escapes.md` → "Parsing
 * location").
 */
const ownerPtyStreams = new Map<string, ProcessedPtyStream>();

// The extension-host parser has no DOM, so webviews push their resolved terminal
// theme colors (see VSCodeAdapter.pushThemeColors). Cached here and read lazily
// per query so the parser can answer OSC 10/11/12 like the standalone adapter;
// null until the first push, in which case queries fall through to xterm.js.
let latestThemeColors: TerminalColors | null = null;
const themeColorProvider: TerminalColorProvider = (target) => latestThemeColors?.[target] ?? null;

// Subscribers that want each PTY chunk *after* OSC sequences have been parsed
// out (display path). Decoupled from ptyManager.addCallbacks so we only run
// the protocol parser once per chunk regardless of webview count.
type ProcessedDataListener = (id: string, visibleData: string, textData?: string) => void;
const processedDataListeners = new Set<ProcessedDataListener>();
type ProcessedExitListener = (id: string, exitCode: number) => void;
const processedExitListeners = new Set<ProcessedExitListener>();
type SemanticEventsListener = (id: string, events: TerminalSemanticEvent[]) => void;
const semanticEventsListeners = new Set<SemanticEventsListener>();
const toolEventsListeners = new Set<(id: string, events: TerminalProtocolEvent[]) => void>();

export function onProcessedPtyData(listener: ProcessedDataListener): () => void {
  processedDataListeners.add(listener);
  return () => { processedDataListeners.delete(listener); };
}

export function onProcessedPtyExit(listener: ProcessedExitListener): () => void {
  processedExitListeners.add(listener);
  return () => { processedExitListeners.delete(listener); };
}

function onTerminalSemanticEvents(listener: SemanticEventsListener): () => void {
  semanticEventsListeners.add(listener);
  return () => { semanticEventsListeners.delete(listener); };
}

alertManager.onStateChange((id, state) => {
  log.info(`[alert] ${id}: → ${state.status} (todo=${state.todo})`);
});

// Feed PTY data to the alert manager so it can track activity.
// This is module-level so it runs regardless of webview visibility.
ptyManager.addCallbacks({
  onData(id: string, data: string) {
    getOwnerPtyStream(id).write(data);
  },
  onExit(id: string, exitCode: number) {
    log.info(`[alert-feed] ${id}: PTY exited`);
    alertManager.onExit(id, exitCode);
    ownerPtyStreams.delete(id);
    for (const listener of processedExitListeners) listener(id, exitCode);
  },
});

ptyManager.onDorControlRequest((request) => {
  // Refused here rather than in the webview: only the extension host knows
  // this window holds several Dormouse webviews, each its own Workspace
  // (`dor-workspace-guard.ts`).
  const refusal = dorWorkspaceRefusal(request.method, request.params);
  if (refusal) {
    ptyManager.respondDorControl({ requestId: request.requestId, ok: false, error: refusal });
    return;
  }
  const routers = [...activeRouters];
  const router = request.surfaceId
    ? routers.find((candidate) => candidate.ownsPty(request.surfaceId!))
    : routers[0];

  if (!router) {
    ptyManager.respondDorControl({
      requestId: request.requestId,
      ok: false,
      error: request.surfaceId
        ? `No Dormouse webview owns surface '${request.surfaceId}'`
        : 'No Dormouse webview is available to handle dor',
    });
    return;
  }

  router.forwardDorControlRequest(request);
});

// Broadcast rather than route: only the webview actually holding this requestId
// has anything to abort, and it recognizes its own id. Tracking which router got
// which request would buy nothing a no-op lookup does not already give us.
ptyManager.onDorControlCancel((cancel) => {
  broadcastToWebviews({ type: 'dor:controlCancel', requestId: cancel.requestId });
});

function getOwnerPtyStream(id: string): ProcessedPtyStream {
  let stream = ownerPtyStreams.get(id);
  if (!stream) {
    stream = createOwnerPtyStream(id, {
      alerts: alertManager,
      colorProvider: themeColorProvider,
      onToolEvents: (events) => { for (const listener of toolEventsListeners) listener(id, events); },
      onSemanticEvents: (events) => { for (const listener of semanticEventsListeners) listener(id, events); },
      writeResponse: (response) => ptyManager.write(id, response),
      onChunk: (chunk) => { for (const listener of processedDataListeners) listener(id, chunk.data, chunk.textData); },
    });
    ownerPtyStreams.set(id, stream);
  }
  return stream;
}

/**
 * Attach one remote sink to a PTY's own parse, so it inherits the byte
 * boundaries of everything that came before it — and, when it lands inside a
 * forwarded string control, waits out that payload.
 */
function subscribeProcessedPty(
  ptyId: string,
  onChunk: (chunk: ProcessedPtyChunk) => void,
): () => void {
  const stream = getOwnerPtyStream(ptyId);
  const unsubscribe = stream.subscribe(onChunk);
  return () => {
    unsubscribe();
    // A stream stood up only to serve an attachment to a PTY that is no longer
    // live has nothing left to parse, and the exit that would have retired it
    // has been and gone; without this the window retains one parser per surface
    // id that was ever attached to. Liveness, not `hasPty`, which stays true for
    // a PTY that has already exited.
    if (stream.hasSinks || ptyManager.getPtyStatus(ptyId)?.alive === true) return;
    if (ownerPtyStreams.get(ptyId) === stream) ownerPtyStreams.delete(ptyId);
  };
}

export function getAlertStates() {
  return alertManager.getAllStates();
}

export async function flushAllSessions(timeoutMs = 1000): Promise<void> {
  await Promise.all([...activeRouters].map((router) => router.flushSessionSave(timeoutMs)));
}

export function attachRouter(
  channel: WebviewChannel,
  options?: {
    reconnect?: boolean;
    killOnDispose?: boolean;
    onSaveState?: (state: unknown) => void | PromiseLike<void>;
    getSelectedShell?: () => { shell?: string; args?: string[] } | null;
    // Called with this webview's Workspace union status whenever it changes
    // (owned-PTY alert state, or a PTY claimed/released). The host reflects it
    // onto native chrome (tab title / view badge). See docs/specs/vscode.md.
    onUnion?: (union: WorkspaceUnion) => void;
  },
): vscode.Disposable {
  const reconnect = options?.reconnect ?? false;
  const killOnDispose = options?.killOnDispose ?? false;
  // Also this webview's realm of the alerts, so one webview's blur never
  // touches another's (docs/specs/alert.md → Engagement).
  const routerId = `router-${++nextRouterId}`;

  // The router's only send path — it stamps this webview's message token, which
  // the webview requires (docs/specs/vscode.md → "Webview message
  // authentication"). A raw `vscode.Webview` never reaches this scope.
  const post = (message: ExtensionMessage): Thenable<boolean> => channel.post(message);

  // Track which PTY IDs were spawned (or reconnected) through this webview
  const ownedPtyIds = new Set<string>();
  const pendingFlushRequests = new Map<string, { resolve: () => void; timeout: ReturnType<typeof setTimeout> }>();
  let pendingSave = Promise.resolve();
  let disposed = false;

  // Webview-facing subscriptions — only active when the webview has live content.
  // Subscribed on dormouse:init, unsubscribed when webview content is gone.
  let disconnectWebview: (() => void) | null = null;
  const removeWatchedCommandListener = alertHost.watched.subscribe((names) => {
    void post({ type: 'alert:watchedCommands', names } satisfies ExtensionMessage);
  });
  const removeAlertSettingsListener = alertHost.settings.subscribe((settings) => {
    void post({ type: 'alert:settings', settings } satisfies ExtensionMessage);
  });
  /** Where the alerts answer this webview. Posted even while it is being
   *  disposed: a realm's end answers what it parked synchronously. */
  const realm: AlertRealm = {
    answer: (result) => void post({ type: 'alert:awaitResult', ...result } satisfies ExtensionMessage),
    resendStates: (ids) => {
      for (const id of ids) {
        if (ownedPtyIds.has(id)) post({ type: 'alert:state', id, ...alertManager.getState(id) } satisfies ExtensionMessage);
      }
    },
    resendWatchedCommands: (names) => void post({ type: 'alert:watchedCommands', names } satisfies ExtensionMessage),
    resendSettings: (settings) => void post({ type: 'alert:settings', settings } satisfies ExtensionMessage),
  };

  function claim(id: string): void {
    ownedPtyIds.add(id);
    globalOwnedPtyIds.add(id);
    notifyUnion();
  }

  function release(id: string): void {
    ownedPtyIds.delete(id);
    globalOwnedPtyIds.delete(id);
    notifyUnion();
  }

  // Project this webview's Workspace union over its owned PTYs and hand it to
  // the host so it can update native chrome. Reuses the shared projection so the
  // rule (only terminals ring; any surface may TODO; count owing attention)
  // matches everywhere (docs/specs/alert.md).
  function notifyUnion(): void {
    if (!options?.onUnion) return;
    const states = new Map<string, ActivityState>();
    for (const id of ownedPtyIds) states.set(id, alertManager.getState(id));
    options.onUnion(computeWorkspaceUnion(ownedPtyIds, states));
  }

  function resolveFlushRequest(requestId: string): void {
    const pending = pendingFlushRequests.get(requestId);
    if (!pending) return;
    pendingFlushRequests.delete(requestId);
    clearTimeout(pending.timeout);
    pending.resolve();
  }

  function resolveAllFlushRequests(): void {
    for (const requestId of [...pendingFlushRequests.keys()]) {
      resolveFlushRequest(requestId);
    }
  }

  function flushSessionSave(timeoutMs = 1000): Promise<void> {
    if (disposed || !disconnectWebview) return Promise.resolve();

    const requestId = `flush-${++nextFlushRequestId}`;
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        pendingFlushRequests.delete(requestId);
        resolve();
      }, timeoutMs);

      pendingFlushRequests.set(requestId, {
        resolve,
        timeout,
      });

      void post({ type: 'dormouse:flushSessionSave', requestId } satisfies ExtensionMessage);
    });
  }

  function ownsPty(id: string): boolean {
    return ownedPtyIds.has(id);
  }

  function forwardDorControlRequest(request: DorControlRequest): void {
    void post({
      type: 'dor:controlRequest',
      requestId: request.requestId,
      surfaceId: request.surfaceId,
      method: request.method,
      params: request.params ?? {},
    } satisfies ExtensionMessage).then(
      (posted) => {
        if (posted) return;
        ptyManager.respondDorControl({
          requestId: request.requestId,
          ok: false,
          error: 'Dormouse webview is not available to handle dor',
        });
      },
      (err) => {
        ptyManager.respondDorControl({
          requestId: request.requestId,
          ok: false,
          error: `Failed to forward dor request: ${err?.message ?? err}`,
        });
      },
    );
  }

  /**
   * Subscribe PTY data and alert state forwarding to the webview.
   * Called when the webview sends dormouse:init (proving it has live content).
   * Returns a cleanup function that unsubscribes everything.
   */
  function connectWebview(): () => void {
    const removeProcessedListener = onProcessedPtyData((id, visibleData, textData) => {
      if (!ownedPtyIds.has(id)) return;
      post({ type: 'pty:data', id, data: visibleData, textData } satisfies ExtensionMessage);
    });
    const onToolEvents = (id: string, events: TerminalProtocolEvent[]) => {
      if (ownedPtyIds.has(id)) post({ type: 'terminal:toolEvents', id, events } satisfies ExtensionMessage);
    };
    toolEventsListeners.add(onToolEvents);
    const removeSemanticListener = onTerminalSemanticEvents((id, events) => {
      if (!ownedPtyIds.has(id)) return;
      post({ type: 'terminal:semanticEvents', id, events } satisfies ExtensionMessage);
    });
    const removeExitListener = onProcessedPtyExit((id, exitCode) => {
      if (!ownedPtyIds.has(id)) return;
      post({ type: 'pty:exit', id, exitCode } satisfies ExtensionMessage);
    });

    const removeAlertListener = alertManager.onStateChange((id, state) => {
      if (!ownedPtyIds.has(id)) return;
      post({ type: 'alert:state', id, ...state } satisfies ExtensionMessage);
      notifyUnion();
    });
    // Speech needs a renderer, so a Session no connected webview shows is not
    // spoken (`docs/specs/alert.md` -> Alarm settings).
    const removeSpeakListener = alertHost.onSpeak((speak) => {
      if (ownedPtyIds.has(speak.id)) post({ type: 'alert:speak', ...speak } satisfies ExtensionMessage);
    });

    return () => {
      removeProcessedListener();
      removeSemanticListener();
      toolEventsListeners.delete(onToolEvents);
      removeExitListener();
      removeAlertListener();
      removeSpeakListener();
    };
  }

  const messageDisposable = channel.onDidReceiveMessage((msg: WebviewMessage) => {
    switch (msg.type) {
      case 'pty:context': {
        const request = msg.request;
        if ((request.op !== 'settings' && !ownedPtyIds.has(request.id)) || (request.op === 'promote' && request.restore && !ownedPtyIds.has(request.restore.parentId))) {
          post({ type: 'pty:contextResult', requestId: msg.requestId, result: { error: 'Terminal is not owned by this workspace' } });
          break;
        }
        ptyManager.terminalContext(request).then(result => {
          if (!result.error && request.op === 'promote') alertManager.setHelper(request.id, !!request.restore);
          post({ type: 'pty:contextResult', requestId: msg.requestId, result });
        }, error => post({ type: 'pty:contextResult', requestId: msg.requestId, result: { error: String(error) } }));
        break;
      }
      case 'pty:spawn': {
        if (msg.options?.helper && (!ownedPtyIds.has(msg.options.helper.parentId) || ptyManager.helperPtys.has(msg.options.helper.parentId))) {
          post({ type: 'pty:exit', id: msg.id, exitCode: 1 });
          break;
        }
        const { alert, ...spawnOptions } = msg.options ?? {};
        // Claimed first, so the state a cold restore's persisted TODO seeds
        // reaches this webview.
        claim(msg.id);
        // A fresh generation under this id: its alert state starts over, and
        // the parser is retired rather than let its half-read sequence splice
        // onto the new PTY's first bytes.
        alertHost.respawn(msg.id, alert);
        if (msg.options?.helper) alertManager.setHelper(msg.id, true);
        ownerPtyStreams.delete(msg.id);
        if (!spawnOptions.cwd) {
          spawnOptions.cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        }
        ptyManager.spawn(msg.id, spawnOptions);
        break;
      }
      case 'pty:input':
        alertedPtys.write(msg.id, msg.data, { paced: msg.paced, userInput: msg.userInput === true });
        break;
      case 'pty:resize':
        alertedPtys.resize(msg.id, msg.cols, msg.rows);
        break;
      case 'pty:kill':
        release(msg.id);
        // The Session is over: its alert state goes, as a closing panel's does.
        alertManager.remove(msg.id);
        ownerPtyStreams.delete(msg.id);
        ptyManager.kill(msg.id);
        break;
      case 'pty:getCwd':
        ptyManager.getCwd(msg.id).then((cwd) => {
          post({ type: 'pty:cwd', id: msg.id, cwd, requestId: msg.requestId } satisfies ExtensionMessage);
        });
        break;
      case 'pty:getOpenPorts':
        ptyManager.getOpenPorts(msg.id).then((ports) => {
          post({ type: 'pty:openPorts', id: msg.id, ports, requestId: msg.requestId } satisfies ExtensionMessage);
        });
        break;
      case 'pty:getShells':
        ptyManager.getAvailableShells().then((shells) => {
          post({
            type: 'pty:shells', shells, requestId: msg.requestId,
          } satisfies ExtensionMessage);
        });
        break;
      case 'clipboard:readFiles':
        clipboardOps.readClipboardFilePaths()
          .then((paths) => post({
            type: 'clipboard:files', paths: paths.length ? paths : null, requestId: msg.requestId,
          } satisfies ExtensionMessage))
          .catch((err) => {
            log.info(`[clipboard] readFiles failed: ${err?.message ?? err}`);
            post({ type: 'clipboard:files', paths: null, requestId: msg.requestId } satisfies ExtensionMessage);
          });
        break;
      case 'clipboard:readImage':
        clipboardOps.readClipboardImageAsFilePath()
          .then((path) => post({
            type: 'clipboard:image', path, requestId: msg.requestId,
          } satisfies ExtensionMessage))
          .catch((err) => {
            log.info(`[clipboard] readImage failed: ${err?.message ?? err}`);
            post({ type: 'clipboard:image', path: null, requestId: msg.requestId } satisfies ExtensionMessage);
          });
        break;
      case 'dormouse:openExternal': {
        const uri = normalizeExternalUri(msg.uri);
        if (!uri) break;
        void vscode.env.openExternal(vscode.Uri.parse(uri, true)).then(
          (opened) => {
            if (!opened) log.info(`[external-link] openExternal declined: ${uri}`);
          },
          (err) => log.info(`[external-link] openExternal failed: ${err?.message ?? err}`),
        );
        break;
      }
      case 'dormouse:runWorkbenchCommand':
        if (ALLOWED_WORKBENCH_COMMANDS.has(msg.command)) {
          void vscode.commands.executeCommand(msg.command);
        }
        break;
      case 'browser:request':
        // Validated host-side (`parseBrowserRequest`): the request arrives from
        // the webview realm.
        runBrowserRequest(msg.request).then((result) => {
          post({ type: 'browser:result', requestId: msg.requestId, result } satisfies ExtensionMessage);
        });
        break;
      case 'tool:control':
        toolControl(msg.request as ToolHostRequest).then(
          (result) => post({ type: 'tool:result', requestId: msg.requestId, result } satisfies ExtensionMessage),
          (err) => post({
            type: 'tool:result', requestId: msg.requestId,
            result: { status: 'error', message: err?.message ?? String(err) },
          } satisfies ExtensionMessage),
        );
        break;
      case 'iframe:createProxyUrl':
        createIframeProxyUrl(
          typeof msg.url === 'string' ? msg.url : '',
          // Validated host-side (`normalizeEmbedderOrigins`); an unusable chain
          // costs the shim, never a wider grant.
          Array.isArray(msg.embedderOrigins) ? msg.embedderOrigins : [],
        ).then(
          (result) => post({
            type: 'iframe:proxyUrl', requestId: msg.requestId, result,
          } satisfies ExtensionMessage),
          (err) => post({
            type: 'iframe:proxyUrl', requestId: msg.requestId,
            result: { ok: false, reason: 'unreachable', detail: err?.message ?? String(err) },
          } satisfies ExtensionMessage),
        );
        break;
      case 'peer:answer': {
        // Every webview answers, so "nobody owns it" settles immediately
        // instead of waiting out the budget — which is the common case when
        // what was asked about actually lives in another window.
        const request = peerRequests.get(msg.requestId);
        if (!request) {
          // Late: the budget already expired and the Burrow rendered a snapshot
          // without whatever this webview owns. Nothing can re-open a settled
          // request, so mark the directory stale instead — the next collect
          // asks again and repairs it. Without this an idle machine never
          // re-collects and the phone's picker stays wrong indefinitely.
          notifyDirectoryChanged();
          break;
        }
        // Deleted before the results are taken, so a duplicate answer from the
        // same webview cannot contribute its panes twice.
        if (!request.pending.delete(router)) break;
        if (Array.isArray(msg.results)) request.results.push(...msg.results);
        if (request.pending.size === 0) request.settle();
        break;
      }
      case 'peer:notify':
        // The directory is the only thing a webview is asked to answer, so the
        // message carries nothing but the fact that its snapshot may differ.
        notifyDirectoryChanged();
        remoteNotifyPeerChange();
        break;
      case 'burrow:command':
        handleBurrowCommand(msg.payload);
        break;
      case 'dormouse:themeColors':
        // Webview reports its resolved terminal theme; cache for OSC color replies.
        latestThemeColors = { foreground: msg.foreground, background: msg.background, cursor: msg.cursor };
        break;
      case 'dormouse:init': {
        // Webview has (re-)initialized — subscribe to live events.
        // Tear down previous subscriptions first (webview was destroyed and recreated).
        disconnectWebview?.();
        disconnectWebview = connectWebview();
        // Recreated content is a new realm.
        alertHost.endRealm(routerId);

        // Re-publish the currently-selected shell so split-spawns in the
        // freshly-mounted webview know what to use.
        const selected = options?.getSelectedShell?.();
        if (selected) {
          post({
            type: 'dormouse:selectedShell',
            shell: selected.shell,
            args: selected.args,
          } satisfies ExtensionMessage);
        }

        if (!reconnect) {
          // Fresh instance — no existing PTYs to restore
          post({ type: 'pty:list', ptys: [] } satisfies ExtensionMessage);
          break;
        }
        // Snapshot IDs owned before claiming so we can choose the right data source below
        const previouslyOwned = new Set(ownedPtyIds);

        const ptys = ptyManager.getBufferedPtys();
        const reconnectable = new Map<string, { alive: boolean; exitCode?: number; shell?: string }>();

        // Re-serve PTYs this router already owns (webview content was recreated,
        // e.g. WebviewView collapsed then re-expanded — resolveWebviewView is NOT
        // called again, so the same router persists with its owned IDs still set)
        for (const id of previouslyOwned) {
          const info = ptys.get(id);
          if (info) {
            reconnectable.set(id, info);
          }
        }

        // Also claim unowned PTYs (from disposed routers / other webviews)
        for (const [id, info] of ptys) {
          if (!globalOwnedPtyIds.has(id)) {
            claim(id);
            reconnectable.set(id, info);
          }
        }

        const list: ExtensionMessage = {
          type: 'pty:list',
          ptys: Array.from(reconnectable.entries()).map(([id, info]) => ({
            id, alive: info.alive, exitCode: info.exitCode, shell: info.shell,
            ...(ptyManager.helperPtys.has(id) ? { helper: ptyManager.helperPtys.get(id) } : {}),
          })),
        };
        post(list);
        for (const [id] of reconnectable) {
          // For already-owned PTYs the replay buffer was consumed on first connect,
          // so use scrollback (full history, never cleared).
          // For newly-claimed PTYs use replay (all data since spawn, clears buffer).
          const data = previouslyOwned.has(id)
            ? ptyManager.getScrollback(id)
            : ptyManager.getReplayData(id);
          if (data) {
            const replay: ExtensionMessage = { type: 'pty:replay', id, data };
            post(replay);
          }
        }
        for (const [id] of reconnectable) {
          const alertState = alertManager.getState(id);
          log.info(`[alert-reconnect] ${id}: sending ${alertState.status} (todo=${alertState.todo})`);
          post({ type: 'alert:state', id, ...alertState } satisfies ExtensionMessage);
        }
        break;
      }
      case 'dormouse:flushSessionSaveDone':
        // The webview has sent its snapshot, but workspaceState.update may still
        // be writing it. Keep the existing deadline while awaiting those writes
        // so deactivate's subsequent refresh reads the completed snapshot.
        void pendingSave.then(() => resolveFlushRequest(msg.requestId));
        break;
      case 'dormouse:saveState':
        // Preserve snapshot order even when a host persistence callback is async.
        pendingSave = pendingSave.then(() => options?.onSaveState?.(msg.state)).catch((error) => {
          log.error('[session] save failed:', String(error));
        });
        break;
      case 'dor:controlResponse':
        ptyManager.respondDorControl({
          requestId: msg.requestId,
          ok: msg.ok,
          result: msg.result,
          error: msg.error,
        });
        break;

      case 'alert:command':
        alertHost.handle(routerId, msg.command, realm);
        break;
    }
  });

  const router = {
    flushSessionSave,
    ownsPty,
    forwardDorControlRequest,
    send(message: ExtensionMessage) {
      if (disposed) return;
      void post(message);
    },
    ask(requestId: string, op: string, params: unknown) {
      if (disposed) return;
      void post({ type: 'peer:ask', requestId, op, params } satisfies ExtensionMessage);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeRouters.delete(router);
      // One fewer webview to ask means the directory's answer changed, even if
      // no surface did.
      notifyDirectoryChanged();
      remoteNotifyPeerChange();
      // A webview that goes away mid-fan-out must not hold the answer open.
      for (const request of peerRequests.values()) {
        if (!request.pending.delete(router)) continue;
        if (request.pending.size === 0) request.settle();
      }
      alertHost.endRealm(routerId);
      removeWatchedCommandListener();
      removeAlertSettingsListener();
      resolveAllFlushRequests();
      disconnectWebview?.();
      disconnectWebview = null;
      const toKill = killOnDispose ? [...ownedPtyIds] : [];
      for (const id of ownedPtyIds) {
        if (!killOnDispose) globalOwnedPtyIds.delete(id);
        if (killOnDispose) ownerPtyStreams.delete(id);
      }
      ownedPtyIds.clear();
      messageDisposable.dispose();
      for (const id of toKill) {
        try { ptyManager.kill(id); }
        finally {
          globalOwnedPtyIds.delete(id);
          // A killed Session's alert state goes, as on `pty:kill`.
          alertManager.remove(id);
        }
      }
    },
  };

  activeRouters.add(router);
  notifyDirectoryChanged();
  remoteNotifyPeerChange();
  return router;
}

import * as vscode from 'vscode';
import * as ptyManager from './pty-manager';
import { AlertManager } from '../../lib/src/lib/alert-manager';
import { WatchedCommandHost } from '../../lib/src/lib/watched-command-host';
import { AlertSettingsHost } from '../../lib/src/lib/alert-settings-host';
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  collectTerminalProtocolResponses,
  TerminalProtocolParser,
  type TerminalColorProvider,
  type TerminalColors,
} from '../../lib/src/lib/terminal-protocol';
import { normalizeExternalUri } from '../../lib/src/lib/external-links';
import { VSCODE_WORKBENCH_COMMANDS } from '../../lib/src/lib/vscode-keybindings';
import { computeWorkspaceUnion, type WorkspaceUnion } from '../../lib/src/lib/workspace-union';
import type { ActivityState } from '../../lib/src/lib/session-activity-store';
import type { TerminalSemanticEvent } from '../../lib/src/lib/terminal-state';
import type { PersistedSession } from '../../lib/src/lib/session-types';
import type { WebviewMessage, ExtensionMessage } from './message-types';
import type { DorControlRequest } from './pty-manager';
import { createStreamRelayUrl, runAgentBrowserCommand, runAgentBrowserEdit, runAgentBrowserOpen, runAgentBrowserPopIn, runAgentBrowserPopOut, runAgentBrowserScreenshot, runAgentBrowserStreamStatus } from './agent-browser-host';
import { createIframeProxyUrl } from './iframe-proxy-host';
import { ASK_BUDGET_MS } from '../../lib/src/host/remote/service-protocol';
import { configurePeerLink, remoteNotifyPeerChange } from './peer-link';
import { createProcessedPtyStreams } from './processed-pty-streams';
import {
  configureRemoteHost,
  deliverCommandResult,
  deliverUiEvent,
  dropForwardedCommands,
  greetPeerWindow,
  handleForwardedCommand,
  handleRemoteHostCommand,
  notifyDirectoryChanged,
} from './remote-host';
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
  onProcessedPtyData,
  onProcessedPtyExit,
  ptyManager.getPtyStatus,
);

// The link reaches other windows; it must never call back into a fan-out that
// would reach them again, so it only ever gets the in-window broker.
configurePeerLink({
  brokerRequest,
  invalidateDirectory: notifyDirectoryChanged,
  streamPty: processedPtyStreams.streamPty,
  writePty: (ptyId, data) => ptyManager.write(ptyId, data),
  resizePty: (ptyId, cols, rows) => ptyManager.resize(ptyId, cols, rows),
  // Peer PTYs use generated provider-local route handles. Keep those handles
  // outside this window's real PTY namespace so local ids always fall through
  // to the manager that owns them.
  ownsPty: (ptyId) => ptyManager.hasPty(ptyId) || globalOwnedPtyIds.has(ptyId),
  // The Host half: which of these fire depends on which side of the bind this
  // window landed on, and the link is what knows that.
  handleForwardedCommand,
  dropForwardedCommands,
  deliverCommandResult,
  deliverUiEvent,
  onClientAuthenticated: greetPeerWindow,
});

configureRemoteHost({
  brokerRequest,
  broadcastToWebviews,
  streamPty: processedPtyStreams.streamPty,
  writePty: (ptyId, data) => ptyManager.write(ptyId, data),
  resizePty: (ptyId, cols, rows) => ptyManager.resize(ptyId, cols, rows),
});

/**
 * Put one question to every webview in this window and settle with everything
 * they answered.
 *
 * The remote Host runs in the extension host, but a window's terminals are
 * spread across its webviews — each has its own xterm registry, so the Host can
 * neither list nor attach to a pane without asking. See docs/specs/vscode.md →
 * "Peer surfaces".
 *
 * `op` and `params` are opaque here on purpose: the operation map lives in
 * `lib/src/remote/host/peer-surfaces.ts`, and one fan-out rule covers all of
 * it — every webview answers with zero or more results, so a webview that owns
 * nothing settles the request as fast as the one that does. The budget is the
 * backstop for a webview with no live content, which must not hang the phone's
 * picker; it is the *inner* one, deliberately shorter than the broker's
 * cross-window `PEER_REPLY_BUDGET_MS`, which has to contain a whole run of this
 * plus two socket hops. The asker is this window's own Host service, or the
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
 * The Host's results ride this rather than a reply to one webview: the service
 * answers an `rhId`, and only the adapter that minted it holds a pending
 * command for it (`lib/src/lib/platform/vscode-adapter.ts`).
 */
function broadcastToWebviews(message: ExtensionMessage): void {
  for (const router of activeRouters) router.send(message);
}

const activeRouters = new Set<ActiveRouter>();
let nextFlushRequestId = 0;
const ALLOWED_WORKBENCH_COMMANDS = new Set<string>(VSCODE_WORKBENCH_COMMANDS);

// Shared alert manager — survives router disposal so alert state persists
// across webview collapse/expand cycles.
const alertManager = new AlertManager();
const watchedCommandHost = new WatchedCommandHost(alertManager);
const alertSettingsHost = new AlertSettingsHost(alertManager);
const alertProtocolParsers = new Map<string, TerminalProtocolParser>();

// The extension-host parser has no DOM, so webviews push their resolved terminal
// theme colors (see VSCodeAdapter.pushThemeColors). Cached here and read lazily
// per query so the parser can answer OSC 10/11/12 like the standalone adapter;
// null until the first push, in which case queries fall through to xterm.js.
let latestThemeColors: TerminalColors | null = null;
const themeColorProvider: TerminalColorProvider = (target) => latestThemeColors?.[target] ?? null;

// Subscribers that want each PTY chunk *after* OSC sequences have been parsed
// out (display path). Decoupled from ptyManager.addCallbacks so we only run
// the protocol parser once per chunk regardless of webview count.
type ProcessedDataListener = (id: string, visibleData: string) => void;
const processedDataListeners = new Set<ProcessedDataListener>();
type ProcessedExitListener = (id: string, exitCode: number) => void;
const processedExitListeners = new Set<ProcessedExitListener>();
type SemanticEventsListener = (id: string, events: TerminalSemanticEvent[]) => void;
const semanticEventsListeners = new Set<SemanticEventsListener>();

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

// Log all alert state transitions (including timer-driven ones)
alertManager.onStateChange((id, state) => {
  log.info(`[alert] ${id}: → ${state.status} (todo=${state.todo})`);
});

// Feed PTY data to the alert manager so it can track activity.
// This is module-level so it runs regardless of webview visibility.
ptyManager.addCallbacks({
  onData(id: string, data: string) {
    const before = alertManager.getState(id).status;
    const parsed = getAlertProtocolParser(id).process(data);
    applyTerminalProtocolEvents(alertManager, id, parsed.events);
    const semanticEvents = collectTerminalSemanticEvents(parsed.events);
    alertManager.applyTerminalSemanticEvents(id, semanticEvents);
    if (semanticEvents.length > 0) {
      for (const listener of semanticEventsListeners) listener(id, semanticEvents);
    }
    for (const response of collectTerminalProtocolResponses(parsed.events)) {
      ptyManager.write(id, response);
    }
    if (parsed.visibleData.length > 0) {
      alertManager.onData(id);
      for (const listener of processedDataListeners) listener(id, parsed.visibleData);
    }
    const after = alertManager.getState(id).status;
    if (before !== after) {
      log.info(`[alert-feed] ${id}: ${before} → ${after}`);
    }
  },
  onExit(id: string, exitCode: number) {
    log.info(`[alert-feed] ${id}: PTY exited`);
    alertManager.onExit(id, exitCode);
    alertProtocolParsers.delete(id);
    for (const listener of processedExitListeners) listener(id, exitCode);
  },
});

ptyManager.onDorControlRequest((request) => {
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

function getAlertProtocolParser(id: string): TerminalProtocolParser {
  let parser = alertProtocolParsers.get(id);
  if (!parser) {
    parser = new TerminalProtocolParser(themeColorProvider);
    alertProtocolParsers.set(id, parser);
  }
  return parser;
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
    onSaveState?: (state: unknown) => void;
    savedSession?: PersistedSession | null;
    getSelectedShell?: () => { shell?: string; args?: string[] } | null;
    // Called with this webview's Workspace union status whenever it changes
    // (owned-PTY alert state, or a PTY claimed/released). The host reflects it
    // onto native chrome (tab title / view badge). See docs/specs/vscode.md.
    onUnion?: (union: WorkspaceUnion) => void;
  },
): vscode.Disposable {
  const reconnect = options?.reconnect ?? false;
  const killOnDispose = options?.killOnDispose ?? false;

  // The router's only send path — it stamps this webview's message token, which
  // the webview requires (docs/specs/vscode.md → "Webview message
  // authentication"). A raw `vscode.Webview` never reaches this scope.
  const post = (message: ExtensionMessage): Thenable<boolean> => channel.post(message);

  // Track which PTY IDs were spawned (or reconnected) through this webview
  const ownedPtyIds = new Set<string>();
  const pendingFlushRequests = new Map<string, { resolve: () => void; timeout: ReturnType<typeof setTimeout> }>();
  let disposed = false;

  // Webview-facing subscriptions — only active when the webview has live content.
  // Subscribed on dormouse:init, unsubscribed when webview content is gone.
  let disconnectWebview: (() => void) | null = null;
  const removeWatchedCommandListener = watchedCommandHost.subscribe((names) => {
    void post({
      type: 'alert:watchedCommands',
      names,
    } satisfies ExtensionMessage);
  });
  const removeAlertSettingsListener = alertSettingsHost.subscribe((settings) => {
    void post({
      type: 'alert:settings',
      settings,
    } satisfies ExtensionMessage);
  });

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
    const removeProcessedListener = onProcessedPtyData((id, visibleData) => {
      if (!ownedPtyIds.has(id)) return;
      post({ type: 'pty:data', id, data: visibleData } satisfies ExtensionMessage);
    });
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
      post({
        type: 'alert:state',
        id,
        status: state.status,
        watchingEnabled: state.watchingEnabled,
        todo: state.todo,
        notification: state.notification,
        attentionDismissedRing: state.attentionDismissedRing,
      } satisfies ExtensionMessage);
      notifyUnion();
    });

    return () => {
      removeProcessedListener();
      removeSemanticListener();
      removeExitListener();
      removeAlertListener();
    };
  }

  // Route webview messages to the PTY manager
  const messageDisposable = channel.onDidReceiveMessage((msg: WebviewMessage) => {
    switch (msg.type) {
      case 'pty:spawn': {
        claim(msg.id);
        alertProtocolParsers.set(msg.id, new TerminalProtocolParser(themeColorProvider));
        const spawnOptions = { ...msg.options };
        if (!spawnOptions.cwd) {
          spawnOptions.cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        }
        ptyManager.spawn(msg.id, spawnOptions);
        break;
      }
      case 'pty:input':
        ptyManager.write(msg.id, msg.data);
        break;
      case 'pty:resize':
        ptyManager.resize(msg.id, msg.cols, msg.rows);
        break;
      case 'pty:kill':
        release(msg.id);
        alertProtocolParsers.delete(msg.id);
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
      case 'agentBrowser:command':
        runAgentBrowserCommand(
          msg.session,
          Array.isArray(msg.args) ? msg.args : [],
          typeof msg.binaryPath === 'string' ? msg.binaryPath : undefined,
        ).then((result) => {
          post({
            type: 'agentBrowser:commandResult', requestId: msg.requestId, ...result,
          } satisfies ExtensionMessage);
        });
        break;
      case 'agentBrowser:edit':
        runAgentBrowserEdit(
          msg.session,
          msg.op,
          typeof msg.binaryPath === 'string' ? msg.binaryPath : undefined,
        ).then((result) => {
          post({
            type: 'agentBrowser:editResult', requestId: msg.requestId, ...result,
          } satisfies ExtensionMessage);
        });
        break;
      case 'agentBrowser:screenshot':
        runAgentBrowserScreenshot(
          msg.session,
          { format: msg.format, quality: msg.quality },
          typeof msg.binaryPath === 'string' ? msg.binaryPath : undefined,
        ).then((result) => {
          post({
            type: 'agentBrowser:screenshotResult', requestId: msg.requestId, ...result,
          } satisfies ExtensionMessage);
        });
        break;
      case 'agentBrowser:streamStatus':
        runAgentBrowserStreamStatus(
          msg.session,
          typeof msg.binaryPath === 'string' ? msg.binaryPath : undefined,
        ).then((result) => {
          post({
            type: 'agentBrowser:streamStatusResult', requestId: msg.requestId, ...result,
          } satisfies ExtensionMessage);
        });
        break;
      case 'agentBrowser:getStreamUrl': {
        const streamPort = Number.isInteger(msg.port) && msg.port > 0 && msg.port <= 65535 ? msg.port : null;
        if (!streamPort) {
          post({ type: 'agentBrowser:streamUrl', requestId: msg.requestId, url: null } satisfies ExtensionMessage);
          break;
        }
        createStreamRelayUrl(streamPort).then(
          (url) => post({
            type: 'agentBrowser:streamUrl', requestId: msg.requestId,
            url,
          } satisfies ExtensionMessage),
          () => post({ type: 'agentBrowser:streamUrl', requestId: msg.requestId, url: null } satisfies ExtensionMessage),
        );
        break;
      }
      case 'agentBrowser:open':
        runAgentBrowserOpen(
          typeof msg.url === 'string' ? msg.url : '',
          { headed: msg.headed === true },
          typeof msg.binaryPath === 'string' ? msg.binaryPath : undefined,
        ).then((result) => {
          post({ type: 'agentBrowser:openResult', requestId: msg.requestId, ...result } satisfies ExtensionMessage);
        });
        break;
      case 'agentBrowser:popOut':
        runAgentBrowserPopOut(
          msg.session,
          { url: typeof msg.url === 'string' ? msg.url : undefined, rect: msg.rect },
          typeof msg.binaryPath === 'string' ? msg.binaryPath : undefined,
        ).then((result) => {
          post({ type: 'agentBrowser:popResult', requestId: msg.requestId, ...result } satisfies ExtensionMessage);
        });
        break;
      case 'agentBrowser:popIn':
        runAgentBrowserPopIn(
          msg.session,
          { url: typeof msg.url === 'string' ? msg.url : undefined },
          typeof msg.binaryPath === 'string' ? msg.binaryPath : undefined,
        ).then((result) => {
          post({ type: 'agentBrowser:popResult', requestId: msg.requestId, ...result } satisfies ExtensionMessage);
        });
        break;
      case 'iframe:createProxyUrl':
        createIframeProxyUrl(typeof msg.url === 'string' ? msg.url : '').then(
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
          // Late: the budget already expired and the Host rendered a snapshot
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
      case 'remoteHost:command':
        handleRemoteHostCommand(msg.payload);
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

        // Cold-start restore: this router has no live PTYs to reconnect,
        // but has a saved session. Seed the AlertManager so freshly-spawned
        // PTYs get the right alert state. Check reconnectable (not ptys)
        // because other routers may own PTYs in the global pool.
        if (reconnectable.size === 0 && options?.savedSession) {
          for (const pane of options.savedSession.panes) {
            if (pane.surfaceType === 'browser') continue;
            if (!globalOwnedPtyIds.has(pane.id)) {
              claim(pane.id);
            }
            if (pane.alert) {
              alertProtocolParsers.delete(pane.id);
              alertManager.seed(pane.id, pane.alert);
            }
          }
        }

        const list: ExtensionMessage = {
          type: 'pty:list',
          ptys: Array.from(reconnectable.entries()).map(([id, info]) => ({
            id, alive: info.alive, exitCode: info.exitCode, shell: info.shell,
          })),
        };
        post(list);
        // Send replay/scrollback data for each reconnectable PTY
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
        // Send current alert state for all reconnectable PTYs
        for (const [id] of reconnectable) {
          const alertState = alertManager.getState(id);
          log.info(`[alert-reconnect] ${id}: sending ${alertState.status} (todo=${alertState.todo})`);
          post({
            type: 'alert:state',
            id,
            status: alertState.status,
            watchingEnabled: alertState.watchingEnabled,
            todo: alertState.todo,
            notification: alertState.notification,
            attentionDismissedRing: alertState.attentionDismissedRing,
          } satisfies ExtensionMessage);
        }
        break;
      }
      case 'dormouse:flushSessionSaveDone':
        resolveFlushRequest(msg.requestId);
        break;
      case 'dormouse:saveState':
        options?.onSaveState?.(msg.state);
        break;
      case 'dor:controlResponse':
        ptyManager.respondDorControl({
          requestId: msg.requestId,
          ok: msg.ok,
          result: msg.result,
          error: msg.error,
        });
        break;

      // Alert actions — proxy to the shared alert manager
      case 'alert:remove':
        alertManager.remove(msg.id);
        break;
      case 'alert:initializeWatchedCommands':
        watchedCommandHost.initialize(msg.names);
        break;
      case 'alert:setCommandWatched':
        watchedCommandHost.setCommandWatched(msg.name, msg.watched);
        break;
      // The host revalidates and clamps: a webview must never be able to install
      // a NaN or absurd timer (`docs/specs/transport.md`).
      case 'alert:initializeSettings':
        alertSettingsHost.initialize(msg.settings);
        break;
      case 'alert:updateSettings':
        alertSettingsHost.update(msg.settings);
        break;
      case 'alert:dismiss':
        alertManager.dismissAlert(msg.id);
        break;
      case 'alert:attend':
        alertManager.attend(msg.id);
        break;
      case 'alert:resize':
        alertManager.onResize(msg.id);
        break;
      case 'alert:clearAttention':
        alertManager.clearAttention(msg.id);
        break;
      case 'alert:toggleTodo':
        alertManager.toggleTodo(msg.id);
        break;
      case 'alert:markTodo':
        alertManager.markTodo(msg.id);
        break;
      case 'alert:clearTodo':
        alertManager.clearTodo(msg.id);
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
      removeWatchedCommandListener();
      removeAlertSettingsListener();
      resolveAllFlushRequests();
      disconnectWebview?.();
      disconnectWebview = null;
      for (const id of ownedPtyIds) {
        globalOwnedPtyIds.delete(id);
        if (killOnDispose) {
          alertProtocolParsers.delete(id);
          ptyManager.kill(id);
        }
      }
      ownedPtyIds.clear();
      messageDisposable.dispose();
    },
  };

  activeRouters.add(router);
  notifyDirectoryChanged();
  remoteNotifyPeerChange();
  return router;
}

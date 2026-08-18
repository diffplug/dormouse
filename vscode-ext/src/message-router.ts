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
import { readStore, REMOTE_HOST_STORE_PREFIX, writeStore } from './remote-host-store';
import { PEER_REPLY_BUDGET_MS } from '../../lib/src/lib/vscode-peer-link-protocol';
import { ensureWindowLease } from './window-lease';
import {
  configurePeerLink,
  isRemotePty,
  remoteRequest,
  remoteResize,
  remoteSubscribe,
  remoteUnsubscribe,
  remoteWrite,
  setPeerLinkRole,
} from './peer-link';
import { log } from './log';
import type { WebviewChannel } from './webview-messaging';

const clipboardOps = require('../../lib/clipboard-ops.cjs') as {
  readClipboardFilePaths(): Promise<string[]>;
  readClipboardImageAsFilePath(): Promise<string | null>;
};

// Global set of PTY IDs claimed by any router instance.
// Prevents reconnecting routers from stealing PTYs owned by other webviews.
const globalOwnedPtyIds = new Set<string>();

/**
 * Arbiter for named single-instance roles across this window's webviews — today
 * only `remote-host`, so exactly one webview holds the `/ws/host` socket and
 * arms alarm push (see `lib/src/remote/host/activation.ts`). The extension host
 * arbitrates because it is the only party that sees every webview and outlives
 * each one. First claimant wins; when the holder is disposed the role is
 * re-offered, so closing the Dormouse view hands the Host to another open one
 * instead of dropping it until a reload.
 */
interface SingletonClaimant {
  wants: Set<string>;
  notify(name: string, held: boolean): void;
}
const singletonClaimants = new Set<SingletonClaimant>();
/** Who currently holds each role — the one place the answer is stored. */
const singletonHolders = new Map<string, SingletonClaimant>();

/**
 * Whether this *window* may hold single-instance roles at all.
 *
 * One extension host runs per window, so the arbitration above is blind to
 * every other window. Left to itself each window would elect its own Host, all
 * of them would connect `/ws/host` with the same enrollment, and the server's
 * displacement would turn into an endless reconnect fight. `window-lease.ts`
 * arbitrates across windows on shared storage; nothing is granted here until it
 * says this window won.
 */
let windowLeaseHeld: boolean | null = null;
let storeReadyForWindowLease = false;

function wantedSingletonNames(): Set<string> {
  const names = new Set<string>();
  for (const claimant of singletonClaimants) {
    for (const name of claimant.wants) names.add(name);
  }
  return names;
}

function onWindowLeaseChange(held: boolean): void {
  if (windowLeaseHeld === held) return;
  windowLeaseHeld = held;
  storeReadyForWindowLease = false;
  // The holder is the Host, so it is also the window every other one reports to.
  setPeerLinkRole(held);
  if (held) {
    // A different window may have committed ACL/enrollment writes since these
    // webviews hydrated. Replace their caches before granting the Host role so
    // the new holder cannot authorize from, or write back, a stale snapshot.
    void refreshStoreCachesForLease().then(() => {
      if (windowLeaseHeld !== true) return;
      storeReadyForWindowLease = true;
      for (const name of wantedSingletonNames()) electSingleton(name);
    });
    return;
  }
  // Lost across windows: whoever held it here must stop, not merely stop being
  // re-offered it.
  for (const [name, holder] of singletonHolders) holder.notify(name, false);
  singletonHolders.clear();
}

function electSingleton(name: string): void {
  if (windowLeaseHeld !== true || !storeReadyForWindowLease) return;
  let holder = singletonHolders.get(name);
  if (!holder) {
    holder = [...singletonClaimants].find((claimant) => claimant.wants.has(name));
    if (!holder) return;
    singletonHolders.set(name, holder);
  }
  // Idempotent: re-claiming (a webview remounting) re-answers the holder.
  holder.notify(name, true);
}

function releaseSingletons(claimant: SingletonClaimant): void {
  claimant.wants.clear();
  singletonClaimants.delete(claimant);
  for (const [name, holder] of singletonHolders) {
    if (holder !== claimant) continue;
    singletonHolders.delete(name);
    electSingleton(name);
  }
}
interface ActiveRouter {
  flushSessionSave(timeoutMs?: number): Promise<void>;
  ownsPty(id: string): boolean;
  forwardDorControlRequest(request: DorControlRequest): void;
  notifyStoreChanged(key: string, value: string | null): void;
  notifyStoreSnapshot(prefix: string, entries: Record<string, string>): Thenable<boolean>;
  deliverForeignData(ptyId: string, data: string): void;
  deliverForeignExit(ptyId: string, exitCode: number): void;
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

// The link reaches other windows; it must never call back into a fan-out that
// would reach them again, so it only ever gets the in-window broker.
configurePeerLink({
  brokerRequest,
  deliverRemotePtyData,
  deliverRemotePtyExit,
  onProcessedPtyData,
  writePty: (ptyId, data) => ptyManager.write(ptyId, data),
  resizePty: (ptyId, cols, rows) => ptyManager.resize(ptyId, cols, rows),
});

/**
 * Put one peer request to every webview in this window except `exclude`, and
 * settle with everything they answered.
 *
 * The remote Host runs in one webview, but a window's terminals are spread
 * across all of them — each webview has its own xterm registry, so the Host can
 * neither list nor attach to a sibling's pane without asking. The extension
 * host is the only party that can ask, so it brokers. See docs/specs/vscode.md
 * → "Peer surfaces".
 *
 * `op` and `params` are opaque here on purpose: the operation map lives in
 * `lib/src/remote/host/peer-surfaces.ts`, and one fan-out rule covers all of
 * it — every webview answers with zero or more results, so a webview that owns
 * nothing settles the request as fast as the one that does. The budget is the
 * backstop for a webview with no live content, which must not hang the phone's
 * picker. Callable from a webview request (the Host asking) and from a peer
 * window's socket (tier 2), which is why it is a plain promise rather than
 * message plumbing.
 */
function brokerRequest(op: string, params: unknown, exclude?: ActiveRouter): Promise<unknown[]> {
  const peers = [...activeRouters].filter((router) => router !== exclude);
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
      timer: setTimeout(settle, PEER_REPLY_BUDGET_MS),
    });
    for (const peer of peers) peer.ask(requestId, op, params);
  });
}

/**
 * Hand a webview bytes from a PTY in another *window*.
 *
 * Local PTYs reach a subscriber through `onProcessedPtyData`; a PTY in another
 * window has no such listener here, so the peer link injects it by the same
 * route the subscriber already expects. Only webviews that asked for this PTY
 * receive it, exactly as with a local subscription.
 */
function deliverRemotePtyData(ptyId: string, data: string): void {
  for (const router of activeRouters) router.deliverForeignData(ptyId, data);
}

/** As {@link deliverRemotePtyData}, for that PTY ending. */
function deliverRemotePtyExit(ptyId: string, exitCode: number): void {
  for (const router of activeRouters) router.deliverForeignExit(ptyId, exitCode);
}

/**
 * Tell every webview about a committed Host-store write.
 *
 * Each webview caches the store at boot and serves reads from that cache, so
 * without this a second webview keeps a stale snapshot — and since the lease
 * can hand it the Host later, it would start from that snapshot and write it
 * back, losing every pairing approved by the previous holder. Broadcast to all
 * routers including the writer: re-applying your own write is a no-op, and
 * skipping self would mean identifying it.
 */
function broadcastStoreChange(key: string, value: string | null): void {
  for (const router of activeRouters) router.notifyStoreChanged(key, value);
}

async function refreshStoreCachesForLease(): Promise<void> {
  const entries = await readStore(REMOTE_HOST_STORE_PREFIX).catch(() => ({}));
  if (windowLeaseHeld !== true) return;
  await Promise.all(
    [...activeRouters].map((router) =>
      Promise.resolve(router.notifyStoreSnapshot(REMOTE_HOST_STORE_PREFIX, entries)),
    ),
  );
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
type SemanticEventsListener = (id: string, events: TerminalSemanticEvent[]) => void;
const semanticEventsListeners = new Set<SemanticEventsListener>();

export function onProcessedPtyData(listener: ProcessedDataListener): () => void {
  processedDataListeners.add(listener);
  return () => { processedDataListeners.delete(listener); };
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
  /**
   * PTYs this webview asked to watch without owning them — the remote Host
   * streaming a sibling webview's terminal. Kept separate from `ownedPtyIds` so
   * it never affects Workspace union status, `killOnDispose`, or which webview
   * the host considers the owner.
   */
  const subscribedPtyIds = new Set<string>();

  // This webview's stake in the window-wide single-instance roles.
  const claimant: SingletonClaimant = {
    wants: new Set<string>(),
    notify: (name, held) =>
      void post({ type: 'singleton:lease', name, held } satisfies ExtensionMessage),
  };
  singletonClaimants.add(claimant);
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
      if (!ownedPtyIds.has(id) && !subscribedPtyIds.has(id)) return;
      post({ type: 'pty:data', id, data: visibleData } satisfies ExtensionMessage);
    });
    const removeSemanticListener = onTerminalSemanticEvents((id, events) => {
      // Semantic events drive the *owner's* pane state; a subscriber is
      // streaming bytes, not maintaining a second copy of that state.
      if (!ownedPtyIds.has(id)) return;
      post({ type: 'terminal:semanticEvents', id, events } satisfies ExtensionMessage);
    });
    const removePtyCallbacks = ptyManager.addCallbacks({
      onData() {},
      onExit(id: string, exitCode: number) {
        if (!ownedPtyIds.has(id)) return;
        post({ type: 'pty:exit', id, exitCode } satisfies ExtensionMessage);
      },
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
      removePtyCallbacks();
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
        // `remoteWrite` reports false for anything this window owns.
        if (!remoteWrite(msg.id, msg.data)) ptyManager.write(msg.id, msg.data);
        break;
      case 'pty:resize':
        if (!remoteResize(msg.id, msg.cols, msg.rows)) ptyManager.resize(msg.id, msg.cols, msg.rows);
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
      case 'pty:subscribe':
        if (typeof msg.id !== 'string') break;
        subscribedPtyIds.add(msg.id);
        // A PTY in another window has no local listener to hook; ask its window
        // to start sending it.
        if (isRemotePty(msg.id)) remoteSubscribe(msg.id);
        break;
      case 'pty:unsubscribe':
        if (typeof msg.id !== 'string') break;
        subscribedPtyIds.delete(msg.id);
        if (isRemotePty(msg.id)) remoteUnsubscribe(msg.id);
        break;
      case 'peer:request': {
        // This window's other webviews, plus every window reporting to us. Both
        // at once rather than falling through: what is asked about lives in
        // exactly one of them, and asking in series would pay a whole tier's
        // budget before reaching the tier that owns it.
        const requestId = msg.requestId;
        const { op, params } = msg;
        void Promise.all([brokerRequest(op, params, router), remoteRequest(op, params)]).then(
          ([here, elsewhere]) =>
            post({
              type: 'peer:results', requestId, results: [...here, ...elsewhere],
            } satisfies ExtensionMessage),
        );
        break;
      }
      case 'peer:answer': {
        // Every webview answers, so "nobody owns it" settles immediately
        // instead of waiting out the budget — which is the common case when
        // what was asked about actually lives in another window.
        const request = peerRequests.get(msg.requestId);
        if (!request) break;
        if (Array.isArray(msg.results)) request.results.push(...msg.results);
        request.pending.delete(router);
        if (request.pending.size === 0) request.settle();
        break;
      }
      case 'singleton:claim':
        // `WebviewMessage` is a claim about the sender, not a runtime check.
        if (typeof msg.name !== 'string') break;
        claimant.wants.add(msg.name);
        // First claim in this window starts the cross-window arbitration; it
        // answers asynchronously, and `onWindowLeaseChange` elects when it does.
        ensureWindowLease(onWindowLeaseChange);
        electSingleton(msg.name);
        break;
      case 'store:read':
        // The Host's enrollment + ACL live in extension-host storage, not in
        // webview localStorage (remote-host-store.ts explains why). Both sides
        // gate on the key prefix.
        readStore(typeof msg.prefix === 'string' ? msg.prefix : '')
          .catch(() => ({}))
          .then((entries) => post({
            type: 'store:entries', requestId: msg.requestId, entries,
          } satisfies ExtensionMessage));
        break;
      case 'store:write': {
        // Same bar as `store:read` above: a non-string key would throw inside
        // `allowed()` as an unhandled rejection rather than a refused write.
        const key = msg.key;
        const value = msg.value;
        if (typeof key !== 'string') break;
        if (typeof value !== 'string' && value !== null) break;
        void writeStore(key, value).then((written) => {
          if (written) broadcastStoreChange(key, value);
        });
        break;
      }
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
        const reconnectable = new Map<string, { alive: boolean; exitCode?: number }>();

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
            id, alive: info.alive, exitCode: info.exitCode,
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
    notifyStoreChanged(key: string, value: string | null) {
      if (disposed) return;
      void post({ type: 'store:changed', key, value } satisfies ExtensionMessage);
    },
    notifyStoreSnapshot(prefix: string, entries: Record<string, string>) {
      return post({ type: 'store:snapshot', prefix, entries } satisfies ExtensionMessage);
    },
    ask(requestId: string, op: string, params: unknown) {
      if (disposed) return;
      void post({ type: 'peer:ask', requestId, op, params } satisfies ExtensionMessage);
    },
    deliverForeignData(ptyId: string, data: string) {
      if (disposed || !subscribedPtyIds.has(ptyId)) return;
      void post({ type: 'pty:data', id: ptyId, data } satisfies ExtensionMessage);
    },
    deliverForeignExit(ptyId: string, exitCode: number) {
      if (disposed || !subscribedPtyIds.has(ptyId)) return;
      void post({ type: 'pty:exit', id: ptyId, exitCode } satisfies ExtensionMessage);
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      activeRouters.delete(router);
      // A webview that goes away mid-fan-out must not hold the answer open.
      for (const request of peerRequests.values()) {
        if (!request.pending.delete(router)) continue;
        if (request.pending.size === 0) request.settle();
      }
      subscribedPtyIds.clear();
      releaseSingletons(claimant);
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
  return router;
}

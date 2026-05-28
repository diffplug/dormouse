import * as vscode from 'vscode';
import * as ptyManager from './pty-manager';
import { AlertManager, type SessionStatus } from '../../lib/src/lib/alert-manager';
import {
  applyTerminalProtocolEvents,
  collectTerminalSemanticEvents,
  collectTerminalProtocolResponses,
  TerminalProtocolParser,
} from '../../lib/src/lib/terminal-protocol';
import { normalizeExternalUri } from '../../lib/src/lib/external-links';
import type { TerminalSemanticEvent } from '../../lib/src/lib/terminal-state';
import type { PersistedSession } from '../../lib/src/lib/session-types';
import type { WebviewMessage, ExtensionMessage } from './message-types';
import { log } from './log';

const clipboardOps = require('../../lib/clipboard-ops.cjs') as {
  readClipboardFilePaths(): Promise<string[]>;
  readClipboardImageAsFilePath(): Promise<string | null>;
};

// Global set of PTY IDs claimed by any router instance.
// Prevents reconnecting routers from stealing PTYs owned by other webviews.
const globalOwnedPtyIds = new Set<string>();
const activeRouters = new Set<{ flushSessionSave(timeoutMs?: number): Promise<void> }>();
let nextFlushRequestId = 0;

// Shared alert manager — survives router disposal so alert state persists
// across webview collapse/expand cycles.
const alertManager = new AlertManager();
const alertProtocolParsers = new Map<string, TerminalProtocolParser>();

// Subscribers that want each PTY chunk *after* OSC sequences have been parsed
// out (display path). Decoupled from ptyManager.addCallbacks so we only run
// the protocol parser once per chunk regardless of webview count.
type ProcessedDataListener = (id: string, visibleData: string) => void;
const processedDataListeners = new Set<ProcessedDataListener>();
type SemanticEventsListener = (id: string, events: TerminalSemanticEvent[]) => void;
const semanticEventsListeners = new Set<SemanticEventsListener>();

function onProcessedPtyData(listener: ProcessedDataListener): () => void {
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

function getAlertProtocolParser(id: string): TerminalProtocolParser {
  let parser = alertProtocolParsers.get(id);
  if (!parser) {
    parser = new TerminalProtocolParser();
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
  webview: vscode.Webview,
  options?: {
    reconnect?: boolean;
    killOnDispose?: boolean;
    onSaveState?: (state: unknown) => void;
    savedSession?: PersistedSession | null;
    getSelectedShell?: () => { shell?: string; args?: string[] } | null;
  },
): vscode.Disposable {
  const reconnect = options?.reconnect ?? false;
  const killOnDispose = options?.killOnDispose ?? false;

  // Track which PTY IDs were spawned (or reconnected) through this webview
  const ownedPtyIds = new Set<string>();
  const pendingFlushRequests = new Map<string, { resolve: () => void; timeout: ReturnType<typeof setTimeout> }>();
  let disposed = false;

  // Webview-facing subscriptions — only active when the webview has live content.
  // Subscribed on dormouse:init, unsubscribed when webview content is gone.
  let disconnectWebview: (() => void) | null = null;

  function claim(id: string): void {
    ownedPtyIds.add(id);
    globalOwnedPtyIds.add(id);
  }

  function release(id: string): void {
    ownedPtyIds.delete(id);
    globalOwnedPtyIds.delete(id);
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

      void webview.postMessage({ type: 'dormouse:flushSessionSave', requestId } satisfies ExtensionMessage);
    });
  }

  /**
   * Subscribe PTY data and alert state forwarding to the webview.
   * Called when the webview sends dormouse:init (proving it has live content).
   * Returns a cleanup function that unsubscribes everything.
   */
  function connectWebview(): () => void {
    const removeProcessedListener = onProcessedPtyData((id, visibleData) => {
      if (!ownedPtyIds.has(id)) return;
      webview.postMessage({ type: 'pty:data', id, data: visibleData } satisfies ExtensionMessage);
    });
    const removeSemanticListener = onTerminalSemanticEvents((id, events) => {
      if (!ownedPtyIds.has(id)) return;
      webview.postMessage({ type: 'terminal:semanticEvents', id, events } satisfies ExtensionMessage);
    });
    const removePtyCallbacks = ptyManager.addCallbacks({
      onData() {},
      onExit(id: string, exitCode: number) {
        if (!ownedPtyIds.has(id)) return;
        webview.postMessage({ type: 'pty:exit', id, exitCode } satisfies ExtensionMessage);
      },
    });

    const removeAlertListener = alertManager.onStateChange((id, state) => {
      if (!ownedPtyIds.has(id)) return;
      webview.postMessage({
        type: 'alert:state',
        id,
        status: state.status,
        watchingEnabled: state.watchingEnabled,
        todo: state.todo,
        notification: state.notification,
        attentionDismissedRing: state.attentionDismissedRing,
      } satisfies ExtensionMessage);
    });

    return () => {
      removeProcessedListener();
      removeSemanticListener();
      removePtyCallbacks();
      removeAlertListener();
    };
  }

  // Route webview messages to the PTY manager
  const messageDisposable = webview.onDidReceiveMessage((msg: WebviewMessage) => {
    switch (msg.type) {
      case 'pty:spawn': {
        claim(msg.id);
        alertProtocolParsers.set(msg.id, new TerminalProtocolParser());
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
          webview.postMessage({ type: 'pty:cwd', id: msg.id, cwd, requestId: msg.requestId } satisfies ExtensionMessage);
        });
        break;
      case 'pty:getOpenPorts':
        ptyManager.getOpenPorts(msg.id).then((ports) => {
          webview.postMessage({ type: 'pty:openPorts', id: msg.id, ports, requestId: msg.requestId } satisfies ExtensionMessage);
        });
        break;
      case 'pty:getScrollback':
        webview.postMessage({
          type: 'pty:scrollback', id: msg.id,
          data: ptyManager.getScrollback(msg.id),
          requestId: msg.requestId,
        } satisfies ExtensionMessage);
        break;
      case 'pty:getShells':
        ptyManager.getAvailableShells().then((shells) => {
          webview.postMessage({
            type: 'pty:shells', shells, requestId: msg.requestId,
          } satisfies ExtensionMessage);
        });
        break;
      case 'clipboard:readFiles':
        clipboardOps.readClipboardFilePaths()
          .then((paths) => webview.postMessage({
            type: 'clipboard:files', paths: paths.length ? paths : null, requestId: msg.requestId,
          } satisfies ExtensionMessage))
          .catch((err) => {
            log.info(`[clipboard] readFiles failed: ${err?.message ?? err}`);
            webview.postMessage({ type: 'clipboard:files', paths: null, requestId: msg.requestId } satisfies ExtensionMessage);
          });
        break;
      case 'clipboard:readImage':
        clipboardOps.readClipboardImageAsFilePath()
          .then((path) => webview.postMessage({
            type: 'clipboard:image', path, requestId: msg.requestId,
          } satisfies ExtensionMessage))
          .catch((err) => {
            log.info(`[clipboard] readImage failed: ${err?.message ?? err}`);
            webview.postMessage({ type: 'clipboard:image', path: null, requestId: msg.requestId } satisfies ExtensionMessage);
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
      case 'dormouse:init': {
        // Webview has (re-)initialized — subscribe to live events.
        // Tear down previous subscriptions first (webview was destroyed and recreated).
        disconnectWebview?.();
        disconnectWebview = connectWebview();

        // Re-publish the currently-selected shell so split-spawns in the
        // freshly-mounted webview know what to use.
        const selected = options?.getSelectedShell?.();
        if (selected) {
          webview.postMessage({
            type: 'dormouse:selectedShell',
            shell: selected.shell,
            args: selected.args,
          } satisfies ExtensionMessage);
        }

        if (!reconnect) {
          // Fresh instance — no existing PTYs to restore
          webview.postMessage({ type: 'pty:list', ptys: [] } satisfies ExtensionMessage);
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
        webview.postMessage(list);
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
            webview.postMessage(replay);
          }
        }
        // Send current alert state for all reconnectable PTYs
        for (const [id] of reconnectable) {
          const alertState = alertManager.getState(id);
          log.info(`[alert-reconnect] ${id}: sending ${alertState.status} (todo=${alertState.todo})`);
          webview.postMessage({
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

      // Alert actions — proxy to the shared alert manager
      case 'alert:remove':
        alertManager.remove(msg.id);
        break;
      case 'alert:toggle':
        alertManager.toggleAlert(msg.id);
        break;
      case 'alert:disable':
        alertManager.disableAlert(msg.id);
        break;
      case 'alert:dismiss':
        alertManager.dismissAlert(msg.id);
        break;
      case 'alert:dismissOrToggle':
        alertManager.dismissOrToggleAlert(msg.id, msg.displayedStatus as SessionStatus);
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
    dispose() {
      if (disposed) return;
      disposed = true;
      activeRouters.delete(router);
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

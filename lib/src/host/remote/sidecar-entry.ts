/**
 * Tauri-sidecar binding of {@link RemoteHostService}; see
 * `docs/specs/standalone.md` → "Remote Host service". Stdout is reserved for
 * the JSON-lines bridge, so all logging goes to stderr.
 *
 * The sidecar owns the PTYs, so it is also standalone's terminal-protocol parse
 * site: one parser per PTY generation feeds the webview's `pty:data` and every
 * attached Client alike (`docs/specs/terminal-escapes.md` → "Parsing location").
 */

import {
  createProcessedPtyStream,
  type ProcessedPtyStream,
} from '../../lib/processed-pty-stream';
import {
  collectTerminalProtocolAlerts,
  collectTerminalProtocolResponses,
  collectTerminalSemanticEvents,
  type TerminalColorProvider,
  type TerminalColors,
} from '../../lib/terminal-protocol';
import type {
  HostSurfaceProvider,
  PtySink,
} from '../../remote/host/host-surface-provider';
import { createAskSurfaceProvider } from './ask-surface-provider';
import { bakedConnectSrc } from './connect-src';
import { createEphemeralHostStateStore, FileHostStateStore } from './host-state-store';
import { RemoteHostService } from './service';
import {
  ASK_BUDGET_MS,
  REMOTE_HOST_ASK_EVENT,
  isRemoteHostCommand,
  type AnswerParams,
} from './service-protocol';

/** The slice of `pty-core`'s manager the Host drives. */
export interface SidecarPtyManager {
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
  /** Whether the current PTY generation still has a live process. */
  hasPty(id: string): boolean;
}

export interface SidecarSurfaceBridgeOptions {
  /** Writes one JSON line to the Rust bridge, which emits it to the webview. */
  send: (event: string, data: unknown) => void;
  mgr: SidecarPtyManager;
}

export interface SidecarSurfaceBridge {
  provider: HostSurfaceProvider;
  /** An `answer` command: settles the ask it names. */
  onAnswer(params: AnswerParams | undefined): void;
  /** A `notify` command: something the directory depends on changed. */
  onNotify(): void;
  /**
   * A `pty-core` event. A `data` event is parsed here and reaches the webview
   * as the events this emits, so `main.js` must not forward it itself.
   */
  onPtyEvent(event: string, data: unknown): void;
  /** A `pty:spawn` command: the id now names a new PTY generation. */
  onPtySpawn(id: unknown): void;
  /**
   * A `pty:themeColors` push. The sidecar has no DOM, so the webview reports its
   * resolved terminal theme for OSC 10/11/12; anything malformed is ignored.
   */
  setThemeColors(colors: unknown): void;
  dispose(): void;
}

/**
 * The provider half: PTYs answered locally, everything about the *view* of them
 * asked of the webview. Separate from {@link createSidecarRemoteHost} so it can
 * be driven directly by tests, and so the next Host to move into its own process
 * can reuse the ask machinery without the sidecar's file store.
 */
export function createSidecarSurfaceBridge(
  options: SidecarSurfaceBridgeOptions,
): SidecarSurfaceBridge {
  interface PendingAsk {
    settle(results: unknown[]): void;
  }
  const asks = new Map<string, PendingAsk>();
  let askSeq = 0;

  function ask(op: string, params: unknown): Promise<unknown[]> {
    const rhId = `ask-${++askSeq}`;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        // Budget spent. An attach must not hang on a webview that is reloading,
        // and a directory that missed a pane re-collects on the next change.
        asks.delete(rhId);
        resolve([]);
      }, ASK_BUDGET_MS);
      // An outstanding ask must never hold the sidecar's event loop open.
      (timer as unknown as { unref?: () => void }).unref?.();
      asks.set(rhId, {
        settle: (results) => {
          clearTimeout(timer);
          asks.delete(rhId);
          resolve(results);
        },
      });
      options.send(REMOTE_HOST_ASK_EVENT, { rhId, op, params });
    });
  }

  // The webview's resolved terminal theme, pushed up because this process has no
  // DOM to read it from (`lib/src/lib/platform/vscode-adapter.ts` does the same
  // for the extension host). Null until the first push, which declines the query
  // and leaves it in `visibleData` for xterm.js.
  let themeColors: TerminalColors | null = null;
  const themeColorProvider: TerminalColorProvider = (target) => themeColors?.[target] ?? null;

  interface Stream {
    /**
     * One parser per PTY generation, not per subscription: what an incomplete
     * escape sequence leaves behind belongs to *this* PTY's byte boundaries and
     * must never be mixed with another's. It outlives every attachment because
     * the webview is a consumer too.
     */
    parsed: ProcessedPtyStream;
    /** Each attached sink, holding the unsubscribe from its own subscription. */
    sinks: Map<PtySink, () => void>;
  }
  const streams = new Map<string, Stream>();
  /** Natural exits outlive their process so a late subscription can replay one. */
  const exits = new Map<string, number>();

  /**
   * The parse site for one PTY, feeding the webview and every Client from the
   * same pass. Order matches the webview's own former order: alerts, then
   * semantic state, then the responses this process writes, then the output.
   */
  function ownerStream(id: string): Stream {
    let stream = streams.get(id);
    if (stream) return stream;
    const parsed = createProcessedPtyStream({
      colorProvider: themeColorProvider,
      onEvents(events) {
        const alerts = collectTerminalProtocolAlerts(events);
        if (alerts.length > 0) options.send('terminal:protocolEvents', { id, events: alerts });
        const semanticEvents = collectTerminalSemanticEvents(events);
        if (semanticEvents.length > 0) {
          options.send('terminal:semanticEvents', { id, events: semanticEvents });
        }
        // Written from here, never from a viewer: the owner is the sole reply
        // authority (`docs/specs/remote-api.md` → Terminal surfaces).
        for (const response of collectTerminalProtocolResponses(events)) {
          options.mgr.write(id, response);
        }
      },
      onChunk(chunk) {
        options.send('pty:data', { id, ...chunk });
      },
    });
    stream = { parsed, sinks: new Map() };
    streams.set(id, stream);
    return stream;
  }

  const { provider, notifyDirectoryChanged } = createAskSurfaceProvider(ask, {
    writePty: (ptyId, data) => options.mgr.write(ptyId, data),
    resizePty: (ptyId, cols, rows) => options.mgr.resize(ptyId, cols, rows),

    streamPty(ptyId, sink) {
      const subscribed = ownerStream(ptyId);
      // One subscription per sink: a sink that attaches while a string control
      // is streaming is held to the next ground byte on its own account
      // (`docs/specs/terminal-escapes.md` → "Parsing location").
      subscribed.sinks.set(sink, subscribed.parsed.subscribe((chunk) => sink.onData(chunk)));
      const unsubscribe = () => {
        // Only while the map still holds the very stream this subscription
        // joined. An exit removes it, and a later attachment to the same id gets
        // a fresh one — so an unsubscribe run twice would silence a stream still
        // flowing. Same guard, same reason, as
        // `vscode-ext/src/processed-pty-streams.ts`.
        if (streams.get(ptyId) !== subscribed) return;
        const stopChunks = subscribed.sinks.get(sink);
        if (!stopChunks) return;
        subscribed.sinks.delete(sink);
        stopChunks();
        // The parser stays: the webview is a consumer of it too, and it is the
        // PTY's generation that owns the byte boundaries, not the attachment.
      };

      // Subscribe first, then inspect the manager on the same event-loop turn.
      // An earlier exit is in `exits`; a later one reaches the sink above. A
      // live result also identifies a new PTY generation that reused this id,
      // so its predecessor's recorded exit can be forgotten safely.
      let alive: boolean;
      try {
        alive = options.mgr.hasPty(ptyId);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      if (alive) {
        exits.delete(ptyId);
      } else {
        const exitCode = exits.get(ptyId) ?? 0;
        unsubscribe();
        // Nothing will feed this parser or retire it: the exit that would have
        // has already been and gone. Without this the sidecar keeps one per
        // surface id that was ever attached to after its PTY died.
        if (subscribed.sinks.size === 0 && streams.get(ptyId) === subscribed) streams.delete(ptyId);
        sink.onExit(exitCode);
      }

      return { stop: unsubscribe, ready: Promise.resolve() };
    },
  });

  return {
    provider,

    /**
     * The first answer settles the ask. Standalone ships one window, so there is
     * exactly one answerer today; the multi-window seam
     * (docs/specs/standalone.md) is where this becomes "collect until the
     * budget".
     */
    onAnswer(params) {
      if (!params || typeof params.rhId !== 'string') return;
      const pending = asks.get(params.rhId);
      if (!pending) {
        // The budget expired before this answer arrived, so the snapshot the
        // Host already rendered is missing whatever it names — an empty
        // directory on a machine that does have terminals. Nothing re-opens a
        // settled ask, so mark the directory stale and let the next collect
        // repair it; otherwise an idle machine has no other reason to
        // re-collect and the phone's picker stays wrong indefinitely.
        notifyDirectoryChanged();
        return;
      }
      pending.settle(Array.isArray(params.results) ? params.results : []);
    },

    onNotify() {
      notifyDirectoryChanged();
    },

    onPtyEvent(event, data) {
      const detail = data as { id?: unknown } | null;
      if (!detail || typeof detail.id !== 'string') return;
      const id = detail.id;
      if (event === 'data') {
        const chunk = (detail as { data?: unknown }).data;
        if (typeof chunk !== 'string') return;
        // Every PTY is parsed, attached or not: the webview's own output is the
        // other side of this parse.
        ownerStream(id).parsed.write(chunk);
        return;
      }
      if (event !== 'exit') return;
      const reported = (detail as { exitCode?: unknown }).exitCode;
      const exitCode = typeof reported === 'number' ? reported : 0;
      // Durable: a surface resolution may already be in flight without a sink.
      exits.set(id, exitCode);
      const stream = streams.get(id);
      if (!stream) return;
      // Dropped before the fan-out, so a sink that unsubscribes from inside its
      // own `onExit` finds nothing left to take out. The parser goes with the
      // generation that filled it; a post-exit flush starts a fresh one.
      streams.delete(id);
      for (const sink of stream.sinks.keys()) sink.onExit(exitCode);
    },

    onPtySpawn(id) {
      // A reused id is a new generation, and a parser holding the last one's
      // half-read sequence would splice it onto the new PTY's first bytes.
      if (typeof id !== 'string') return;
      exits.delete(id);
      const stream = streams.get(id);
      if (!stream) return;
      streams.delete(id);
      // `pty-core` lets a spawn displace a live generation without killing it,
      // and the exit it eventually reports belongs to the new stream. Close the
      // sinks here or they wait on a PTY nothing will ever report for them.
      for (const sink of stream.sinks.keys()) sink.onExit(0);
    },

    setThemeColors(colors) {
      const detail = colors as Partial<Record<keyof TerminalColors, unknown>> | null;
      if (!detail) return;
      const { foreground, background, cursor } = detail;
      if (typeof foreground !== 'string') return;
      if (typeof background !== 'string' || typeof cursor !== 'string') return;
      themeColors = { foreground, background, cursor };
    },

    dispose() {
      for (const pending of [...asks.values()]) pending.settle([]);
      asks.clear();
      streams.clear();
      exits.clear();
    },
  };
}

export interface SidecarRemoteHostOptions extends SidecarSurfaceBridgeOptions {
  /**
   * Where the enrollment + ACL file lives. The browser dev harness passes a
   * per-run temp dir; standalone passes an empty value only when Rust could not
   * create the app-data directory, which falls back to the in-memory store.
   */
  stateDir?: string;
}

export interface SidecarRemoteHost {
  /** One `remoteHost:command` line from the webview. */
  handleCommand(data: unknown): void;
  onPtyEvent(event: string, data: unknown): void;
  onPtySpawn(id: unknown): void;
  setThemeColors(colors: unknown): void;
  dispose(): void;
}

export function createSidecarRemoteHost(options: SidecarRemoteHostOptions): SidecarRemoteHost {
  const store = options.stateDir
    ? new FileHostStateStore(options.stateDir)
    : createEphemeralHostStateStore((message) => console.error(message));

  const bridge = createSidecarSurfaceBridge(options);

  const service = new RemoteHostService({
    store,
    provider: bridge.provider,
    sendToUi: options.send,
    connectSrc: bakedConnectSrc(),
  });
  void service.start().catch((error: unknown) => {
    console.error(`[remote-host] failed to start: ${String(error)}`);
  });

  return {
    handleCommand(data) {
      if (!isRemoteHostCommand(data)) return;
      const command = data;
      // Both of these feed something already waiting on this side, so they
      // answer nothing and never reach the service's dispatch.
      if (command.cmd === 'answer') return bridge.onAnswer(command.params as AnswerParams);
      if (command.cmd === 'notify') return bridge.onNotify();
      void service.handleCommand(command);
    },
    onPtyEvent: bridge.onPtyEvent,
    onPtySpawn: bridge.onPtySpawn,
    setThemeColors: bridge.setThemeColors,
    dispose() {
      service.dispose();
      bridge.dispose();
    },
  };
}

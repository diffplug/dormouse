/**
 * Tauri-sidecar binding of {@link RemoteHostService}; see
 * `docs/specs/standalone.md` → "Remote Host service". Stdout is reserved for
 * the JSON-lines bridge, so all logging goes to stderr.
 */

import type {
  HostSurfaceProvider,
  ProcessedPtyChunk,
  PtySink,
} from '../../remote/host/host-surface-provider';
import { createAskSurfaceProvider } from './ask-surface-provider';
import { bakedConnectSrc } from './connect-src';
import { createEphemeralHostStateStore, FileHostStateStore } from './host-state-store';
import { createPtyStrip } from './pty-strip';
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
  /** A `pty-core` event, tapped before it goes to the webview. */
  onPtyEvent(event: string, data: unknown): void;
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

  interface Stream {
    /**
     * One parser per PTY, not per subscription: what an incomplete escape
     * sequence leaves behind belongs to *this* PTY's byte boundaries and must
     * never be mixed with another's. A late joiner inherits the state from
     * before it joined, which beats a fresh parser starting mid-sequence.
     */
    strip: (data: string) => ProcessedPtyChunk;
    sinks: Set<PtySink>;
  }
  const streams = new Map<string, Stream>();
  /** Natural exits outlive their process so a late subscription can replay one. */
  const exits = new Map<string, number>();

  const { provider, notifyDirectoryChanged } = createAskSurfaceProvider(ask, {
    writePty: (ptyId, data) => options.mgr.write(ptyId, data),
    resizePty: (ptyId, cols, rows) => options.mgr.resize(ptyId, cols, rows),

    streamPty(ptyId, sink) {
      let stream = streams.get(ptyId);
      if (!stream) {
        stream = { strip: createPtyStrip(), sinks: new Set() };
        streams.set(ptyId, stream);
      }
      const subscribed = stream;
      subscribed.sinks.add(sink);
      const unsubscribe = () => {
        // Only while the map still holds the very stream this subscription
        // joined. Once the last sink leaves, the entry goes and a later
        // attachment to the same id gets a fresh one — so an unsubscribe run
        // twice would delete *that* one and silence a stream still flowing.
        // Same guard, same reason, as `vscode-ext/src/processed-pty-streams.ts`.
        if (streams.get(ptyId) !== subscribed) return;
        subscribed.sinks.delete(sink);
        if (subscribed.sinks.size > 0) return;
        // The parser goes with the last attachment: keeping it would carry a
        // half-read sequence into a stream that starts over.
        streams.delete(ptyId);
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
      if (event === 'exit') {
        const exitCode = (detail as { exitCode?: unknown }).exitCode;
        exits.set(detail.id, typeof exitCode === 'number' ? exitCode : 0);
      }
      // Nothing is attached: data can stay cheap, but exits above are durable
      // because a surface resolution may already be in flight without a sink.
      if (streams.size === 0) return;
      const stream = streams.get(detail.id);
      if (!stream) return;
      if (event === 'data') {
        const chunk = (detail as { data?: unknown }).data;
        if (typeof chunk !== 'string') return;
        const processed = stream.strip(chunk);
        // The text projection is a subset of the renderer one, so an empty
        // renderer chunk carries no text either and there is nothing to send.
        if (processed.data === '') return;
        // Iterated live rather than copied: a sink can only unsubscribe itself
        // from here, which a Set tolerates mid-iteration.
        for (const sink of stream.sinks) sink.onData(processed);
        return;
      }
      if (event === 'exit') {
        const code = exits.get(detail.id) ?? 0;
        for (const sink of stream.sinks) sink.onExit(code);
      }
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
    dispose() {
      service.dispose();
      bridge.dispose();
    },
  };
}

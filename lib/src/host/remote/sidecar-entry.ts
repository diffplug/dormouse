/**
 * The Tauri sidecar's binding of {@link RemoteHostService}: bundled to
 * `standalone/sidecar/remote-host.cjs` by
 * `standalone/scripts/build-sidecar-proxy.mjs` and required from
 * `standalone/sidecar/main.js`.
 *
 * The sidecar owns the PTYs, so writes, resizes, and output go straight to
 * `pty-core`'s manager. What it does *not* own is the webview's view of itself
 * — what a pane is called, whether it is focused, how big its xterm is — so
 * those are asked over the bridge in `service-protocol.ts` and answered by the
 * surface responder in `lib/src/remote/host/peer-surfaces.ts`.
 *
 * All logging goes to stderr: stdout is the JSON-lines protocol channel.
 */

import type { HostSurfaceProvider, PtySink } from '../../remote/host/host-surface-provider';
import { createAskSurfaceProvider } from './ask-surface-provider';
import { bakedConnectSrc } from './connect-src';
import { createEphemeralHostStateStore, FileHostStateStore } from './host-state-store';
import { createPtyStrip } from './pty-strip';
import { RemoteHostService } from './service';
import {
  ASK_BUDGET_MS,
  REMOTE_HOST_ASK_EVENT,
  type AnswerParams,
  type NotifyParams,
  type RemoteHostCommand,
} from './service-protocol';

/** The slice of `pty-core`'s manager the Host drives. */
export interface SidecarPtyManager {
  write(id: string, data: string): void;
  resize(id: string, cols: number, rows: number): void;
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
  onNotify(params: NotifyParams | undefined): void;
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
    strip: (data: string) => string;
    sinks: Set<PtySink>;
  }
  const streams = new Map<string, Stream>();

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
      return () => {
        subscribed.sinks.delete(sink);
        // The parser goes with the last attachment: keeping it would carry a
        // half-read sequence into a stream that starts over.
        if (subscribed.sinks.size === 0) streams.delete(ptyId);
      };
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
      asks.get(params.rhId)?.settle(Array.isArray(params.results) ? params.results : []);
    },

    onNotify(params) {
      notifyDirectoryChanged(params?.topic);
    },

    onPtyEvent(event, data) {
      // Nothing is attached: this runs on every chunk of every PTY, and the
      // usual state of a machine with no phone on it is exactly this.
      if (streams.size === 0) return;
      const detail = data as { id?: unknown } | null;
      if (!detail || typeof detail.id !== 'string') return;
      const stream = streams.get(detail.id);
      if (!stream) return;
      if (event === 'data') {
        const chunk = (detail as { data?: unknown }).data;
        if (typeof chunk !== 'string') return;
        const visible = stream.strip(chunk);
        if (visible === '') return;
        // Iterated live rather than copied: a sink can only unsubscribe itself
        // from here, which a Set tolerates mid-iteration.
        for (const sink of stream.sinks) sink.onData(visible);
        return;
      }
      if (event === 'exit') {
        const exitCode = (detail as { exitCode?: unknown }).exitCode;
        const code = typeof exitCode === 'number' ? exitCode : 0;
        for (const sink of stream.sinks) sink.onExit(code);
      }
    },

    dispose() {
      for (const pending of [...asks.values()]) pending.settle([]);
      asks.clear();
      streams.clear();
    },
  };
}

export interface SidecarRemoteHostOptions extends SidecarSurfaceBridgeOptions {
  /** Where the enrollment + ACL file lives; absent in the browser dev harness. */
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
      const command = data as RemoteHostCommand | null;
      if (!command || typeof command.cmd !== 'string') return;
      // Both of these feed something already waiting on this side, so they
      // answer nothing and never reach the service's dispatch.
      if (command.cmd === 'answer') return bridge.onAnswer(command.params as AnswerParams);
      if (command.cmd === 'notify') return bridge.onNotify(command.params as NotifyParams);
      void service.handleCommand(command);
    },
    onPtyEvent: bridge.onPtyEvent,
    dispose() {
      service.dispose();
      bridge.dispose();
    },
  };
}

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

import type { DirectoryEntry } from 'server-lib-common';
import type {
  HostSurfaceProvider,
  PtySink,
  SurfaceHandle,
} from '../../remote/host/host-surface-provider';
import type { PeerSurfaceResult } from '../../remote/host/peer-surfaces';
import { DEFAULT_REMOTE_CONNECT_SRC } from './connect-src';
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

/** Substituted by esbuild at build time; see `scripts/csp-defaults.mjs`. */
declare const __DORMOUSE_REMOTE_CONNECT_SRC__: string;

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

  const directoryWatchers = new Set<() => void>();

  interface Subscription {
    sink: PtySink;
    strip: (data: string) => string;
  }
  const streams = new Map<string, Set<Subscription>>();

  const provider: HostSurfaceProvider = {
    async collectDirectory(): Promise<DirectoryEntry[]> {
      // The responder answers with its whole snapshot, so the results *are* the
      // entries — no per-webview merging to do on this side.
      return (await ask('directory', {})) as DirectoryEntry[];
    },

    watchDirectory(onChange) {
      directoryWatchers.add(onChange);
      return () => {
        directoryWatchers.delete(onChange);
      };
    },

    async resolveSurface(surfaceId, size): Promise<SurfaceHandle | null> {
      // Attach-is-the-resize: the owner applies the size inside this round trip,
      // because there is no way to reach into its xterm afterwards without a
      // second one (docs/specs/remote-api.md).
      const [owner] = (await ask('surfaceOp', {
        surfaceId,
        op: 'attach',
        cols: size.cols,
        rows: size.rows,
      })) as PeerSurfaceResult[];
      if (!owner) return null;

      let cols = owner.cols;
      let rows = owner.rows;
      return {
        ptyId: owner.ptyId,
        get cols() {
          return cols;
        },
        get rows() {
          return rows;
        },
        // The owner is the only one that can read the pane back, so remember
        // what it reported; a resize nobody answered leaves the last known size
        // standing.
        resize: async (nextCols, nextRows) => {
          const [settled] = (await ask('surfaceOp', {
            surfaceId,
            op: 'resize',
            cols: nextCols,
            rows: nextRows,
          })) as PeerSurfaceResult[];
          if (settled) {
            cols = settled.cols;
            rows = settled.rows;
          }
          return { cols, rows };
        },
        // Nothing to unwind: the stream is owned by the `streamPty`
        // subscription, not by holding the surface.
        release: () => {},
      };
    },

    writePty: (ptyId, data) => options.mgr.write(ptyId, data),
    resizePty: (ptyId, cols, rows) => options.mgr.resize(ptyId, cols, rows),

    streamPty(ptyId, sink) {
      const subscription: Subscription = { sink, strip: createPtyStrip() };
      let subscriptions = streams.get(ptyId);
      if (!subscriptions) {
        subscriptions = new Set();
        streams.set(ptyId, subscriptions);
      }
      subscriptions.add(subscription);
      return () => {
        subscriptions.delete(subscription);
        if (subscriptions.size === 0) streams.delete(ptyId);
      };
    },
  };

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
      if (params?.topic !== 'directory') return;
      for (const watcher of [...directoryWatchers]) watcher();
    },

    onPtyEvent(event, data) {
      const detail = data as { id?: unknown } | null;
      if (!detail || typeof detail.id !== 'string') return;
      const subscriptions = streams.get(detail.id);
      if (!subscriptions || subscriptions.size === 0) return;
      if (event === 'data') {
        const chunk = (detail as { data?: unknown }).data;
        if (typeof chunk !== 'string') return;
        for (const subscription of [...subscriptions]) {
          // Each attachment strips on its own parser: the state an incomplete
          // OSC leaves behind belongs to one stream's byte boundaries, not
          // another's.
          const visible = subscription.strip(chunk);
          if (visible !== '') subscription.sink.onData(visible);
        }
        return;
      }
      if (event === 'exit') {
        const exitCode = (detail as { exitCode?: unknown }).exitCode;
        const code = typeof exitCode === 'number' ? exitCode : 0;
        for (const subscription of [...subscriptions]) subscription.sink.onExit(code);
      }
    },

    dispose() {
      for (const pending of [...asks.values()]) pending.settle([]);
      asks.clear();
      directoryWatchers.clear();
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
  const connectSrc =
    typeof __DORMOUSE_REMOTE_CONNECT_SRC__ === 'string'
      ? __DORMOUSE_REMOTE_CONNECT_SRC__
      : DEFAULT_REMOTE_CONNECT_SRC;

  const store = options.stateDir
    ? new FileHostStateStore(options.stateDir)
    : createEphemeralHostStateStore((message) => console.error(message));

  const bridge = createSidecarSurfaceBridge(options);

  const service = new RemoteHostService({
    store,
    provider: bridge.provider,
    sendToUi: options.send,
    connectSrc,
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

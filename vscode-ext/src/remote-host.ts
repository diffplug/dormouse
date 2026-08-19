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
 * only in the window that won, and answers a losing window's webviews with an
 * error rather than a second Host.
 *
 * Nothing here runs until there is a Host to run: contention starts when an
 * enrollment already exists, or on the first `enroll` command. A user who never
 * enrolls never sees a socket.
 */

import type * as vscode from 'vscode';

import { DEFAULT_REMOTE_CONNECT_SRC } from '../../lib/src/host/remote/connect-src';
import { RemoteHostService } from '../../lib/src/host/remote/service';
import {
  REMOTE_HOST_EVENT_EVENT,
  REMOTE_HOST_RESULT_EVENT,
  type RemoteHostCommand,
  type RemoteHostResult,
} from '../../lib/src/host/remote/service-protocol';
import type {
  DirectoryEntry,
  HostSurfaceProvider,
  SurfaceHandle,
} from '../../lib/src/remote/host/host-surface-provider';
import type { PeerSurfaceResult } from '../../lib/src/remote/host/peer-surfaces';
import type { ExtensionMessage } from './message-types';
import { ensurePeerNet } from './peer-link';
import { VsCodeHostStateStore } from './remote-host-store';
import { log } from './log';

/**
 * Remote-server `connect-src` sources, substituted by esbuild at build time
 * (`scripts/esbuild.mjs`). Declared rather than imported so the value is a
 * literal in the bundle and cannot be changed at runtime. The service refuses
 * to enroll with, or connect to, anything outside it.
 */
declare const __DORMOUSE_REMOTE_CONNECT_SRC__: string;

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
let service: RemoteHostService | null = null;
const directoryWatchers = new Set<() => void>();

/**
 * Build the provider the service serves remote-api v1 through.
 *
 * PTYs are answered locally — this process owns them — while everything about
 * the *view* of them is asked of the webviews, because a window's terminals are
 * spread across however many Dormouse views are open and only they hold an
 * xterm registry.
 */
export function createRemoteHostProvider(bound: RemoteHostDeps): HostSurfaceProvider {
  return {
    async collectDirectory(): Promise<DirectoryEntry[]> {
      // Each webview answers with its whole snapshot, so the results *are* the
      // entries — no per-webview merging to do on this side.
      return (await bound.brokerRequest('directory', {})) as DirectoryEntry[];
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
      const [owner] = (await bound.brokerRequest('surfaceOp', {
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
          const [settled] = (await bound.brokerRequest('surfaceOp', {
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

    writePty: (ptyId, data) => bound.writePty(ptyId, data),
    resizePty: (ptyId, cols, rows) => bound.resizePty(ptyId, cols, rows),

    streamPty(ptyId, sink) {
      // No strip parser here, unlike the sidecar: this process already runs the
      // terminal-protocol parser once per chunk and answers its queries, and
      // `onProcessedPtyData` is what comes out the other side. A second parser
      // would answer every query twice and corrupt the PTY.
      const offData = bound.onProcessedPtyData((id, data) => {
        if (id === ptyId) sink.onData(data);
      });
      const offExit = bound.onProcessedPtyExit((id, exitCode) => {
        if (id === ptyId) sink.onExit(exitCode);
      });
      return () => {
        offData();
        offExit();
      };
    },
  };
}

/** Something the directory depends on changed: a pane, an alert, a webview. */
export function notifyDirectoryChanged(): void {
  for (const watcher of [...directoryWatchers]) watcher();
}

function startService(): void {
  if (service || !context || !deps) return;
  const bound = deps;
  service = new RemoteHostService({
    store: new VsCodeHostStateStore(context),
    provider: createRemoteHostProvider(bound),
    sendToUi: (event, data) => {
      // Broadcast rather than reply to one webview: `rhId`s carry a per-adapter
      // tag, so only the webview that asked finds a pending command to settle.
      if (event === REMOTE_HOST_RESULT_EVENT) {
        bound.broadcastToWebviews({ type: 'remoteHost:result', payload: data as RemoteHostResult });
      } else if (event === REMOTE_HOST_EVENT_EVENT) {
        bound.broadcastToWebviews({ type: 'remoteHost:event', payload: data });
      }
    },
    // The `typeof` guard is for the test runner, which has no esbuild define;
    // a real build substitutes both halves with the baked literal.
    connectSrc:
      typeof __DORMOUSE_REMOTE_CONNECT_SRC__ === 'string'
        ? __DORMOUSE_REMOTE_CONNECT_SRC__
        : DEFAULT_REMOTE_CONNECT_SRC,
  });
  void service.start().catch((error: unknown) => {
    log.error(`[remote-host] failed to start: ${String(error)}`);
  });
}

/**
 * Join the contention for the Host and start serving if this window wins it.
 * Idempotent; resolves once a role is settled.
 */
function contendForHost(): Promise<void> {
  return ensurePeerNet((broker) => {
    if (broker) startService();
  });
}

/**
 * Hand one webview command to the Host.
 *
 * A window that lost the bind has no service to run it. Until phase 3b forwards
 * it over the link, say so rather than answering from a Host that is not there
 * — a silent drop would leave the console hook hanging for its whole timeout.
 * `enroll` is the exception: it is how an installation with no Host at all
 * bootstraps, so it starts the contention first and re-checks.
 */
export function handleRemoteHostCommand(payload: RemoteHostCommand | undefined): void {
  if (!payload || typeof payload.rhId !== 'string' || typeof payload.cmd !== 'string') return;
  if (service) {
    void service.handleCommand(payload);
    return;
  }
  if (payload.cmd === 'enroll') {
    void contendForHost().then(() => {
      if (service) void service.handleCommand(payload);
      else refuse(payload.rhId);
    });
    return;
  }
  refuse(payload.rhId);
}

function refuse(rhId: string): void {
  deps?.broadcastToWebviews({
    type: 'remoteHost:result',
    payload: { rhId, error: 'the remote Host runs in another VS Code window' },
  });
}

/**
 * Give the Host its storage and start it if this installation is already
 * enrolled. Nothing contends for the socket otherwise — see the module header.
 */
export function initRemoteHost(ctx: vscode.ExtensionContext): vscode.Disposable {
  context = ctx;
  void new VsCodeHostStateStore(ctx)
    .loadEnrollment()
    .then((enrollment) => {
      if (enrollment) return contendForHost();
    })
    .catch((error: unknown) => {
      log.error(`[remote-host] could not read the enrollment: ${String(error)}`);
    });

  return {
    dispose() {
      service?.dispose();
      service = null;
      directoryWatchers.clear();
      context = null;
    },
  };
}

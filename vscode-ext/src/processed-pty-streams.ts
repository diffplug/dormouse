/**
 * One keyed PTY-stream registry for this window, over the extension host's
 * per-PTY parse (`lib/src/lib/processed-pty-stream.ts`). Input is already
 * protocol-processed; adding a second parser here would answer terminal queries
 * twice.
 */

import type {
  ProcessedPtyChunk,
  PtySink,
} from '../../lib/src/remote/host/host-surface-provider';

export type { ProcessedPtyChunk, PtySink };

export interface ProcessedPtyStreams {
  /**
   * Watch one PTY of this window's; returns the unsubscribe. An `exit` tears
   * every sink on that id down on its own, so the unsubscribe afterwards is a
   * no-op rather than an error.
   */
  streamPty(ptyId: string, sink: PtySink): () => void;
}

export interface PtyStatus {
  alive: boolean;
  exitCode?: number;
}

export function createProcessedPtyStreams(
  subscribeProcessedPty: (
    ptyId: string,
    onChunk: (chunk: ProcessedPtyChunk) => void,
  ) => () => void,
  onProcessedPtyExit: (listener: (id: string, exitCode: number) => void) => () => void,
  getPtyStatus: (id: string) => PtyStatus | undefined,
): ProcessedPtyStreams {
  /** Every attached sink, holding the unsubscribe from its own subscription. */
  const streams = new Map<string, Map<PtySink, () => void>>();
  let stopExitListener: (() => void) | null = null;

  /** Back to costing this window's terminals nothing once nothing is attached. */
  const uninstallIfIdle = (): void => {
    if (streams.size > 0 || !stopExitListener) return;
    stopExitListener();
    stopExitListener = null;
  };

  const install = (): void => {
    if (stopExitListener) return;
    stopExitListener = onProcessedPtyExit((id, exitCode) => {
      const targets = streams.get(id);
      if (!targets) return;
      // Dropped before the fan-out, so a sink that unsubscribes from inside its
      // own `onExit` finds nothing left to take out — and so a re-subscribe
      // during the fan-out keeps the listener rather than losing it below.
      streams.delete(id);
      for (const [target, stopChunks] of targets) {
        stopChunks();
        target.onExit(exitCode);
      }
      uninstallIfIdle();
    });
  };

  return {
    streamPty(ptyId, sink) {
      let sinks = streams.get(ptyId);
      if (!sinks) {
        sinks = new Map();
        streams.set(ptyId, sinks);
      }
      const subscribed = sinks;
      // One subscription per sink rather than one per PTY: a sink that attaches
      // while a string control is streaming has to be held to the next ground
      // byte on its own account (`docs/specs/terminal-escapes.md` → "Parsing
      // location"), which a shared subscription could not do.
      subscribed.set(sink, subscribeProcessedPty(ptyId, (chunk) => sink.onData(chunk)));
      install();

      const unsubscribe = () => {
        // Only if the map still holds the very set this subscription joined: an
        // exit replaces nothing but does remove it, and a later attachment to
        // the same id gets a fresh one that this unsubscribe has no claim on.
        if (streams.get(ptyId) !== subscribed) return;
        const stopChunks = subscribed.get(sink);
        if (!stopChunks) return;
        subscribed.delete(sink);
        stopChunks();
        if (subscribed.size > 0) return;
        streams.delete(ptyId);
        uninstallIfIdle();
      };

      // Subscribe first, then inspect the host's durable liveness record. If the
      // exit happened before installation the record closes the gap; if it
      // happens after the inspection, the listener above receives it. These
      // synchronous steps cannot interleave on the extension-host event loop.
      // Missing means the manager has no live generation under this id, which
      // is also dead from a resolved pane's point of view.
      let status: PtyStatus | undefined;
      try {
        status = getPtyStatus(ptyId);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      if (status?.alive !== true) {
        unsubscribe();
        sink.onExit(status?.exitCode ?? 0);
      }

      return unsubscribe;
    },
  };
}

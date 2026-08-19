/**
 * One keyed registry of this window's own PTY streams, shared by everything that
 * wants one: the Host provider serving a phone (`remote-host.ts`) and the peer
 * link forwarding a terminal to the broker window (`peer-link.ts`).
 *
 * Keyed rather than one listener pair per subscriber, because these run on every
 * chunk of every terminal in the window: a pair per attachment would tax every
 * keystroke of every PTY once per attached surface, and the two callers would
 * each pay it separately. One pair goes in at the first subscription and comes
 * out when the last one goes, so a window with nothing attached pays nothing.
 *
 * No strip parser here, unlike the sidecar: this process already runs the
 * terminal-protocol parser once per chunk and answers its queries, and
 * `onProcessedPtyData` is what comes out the other side. A second parser would
 * answer every query twice and corrupt the PTY.
 */

import type { PtySink } from '../../lib/src/remote/host/host-surface-provider';

export type { PtySink };

export interface ProcessedPtyStreams {
  /**
   * Watch one PTY of this window's; returns the unsubscribe. An `exit` tears
   * every sink on that id down on its own, so the unsubscribe afterwards is a
   * no-op rather than an error.
   */
  streamPty(ptyId: string, sink: PtySink): () => void;
}

export function createProcessedPtyStreams(
  onProcessedPtyData: (listener: (id: string, data: string) => void) => () => void,
  onProcessedPtyExit: (listener: (id: string, exitCode: number) => void) => () => void,
): ProcessedPtyStreams {
  const streams = new Map<string, Set<PtySink>>();
  let stopListeners: (() => void) | null = null;

  /** Back to costing this window's terminals nothing once nothing is attached. */
  const uninstallIfIdle = (): void => {
    if (streams.size > 0 || !stopListeners) return;
    stopListeners();
    stopListeners = null;
  };

  const install = (): void => {
    if (stopListeners) return;
    const offData = onProcessedPtyData((id, data) => {
      const targets = streams.get(id);
      if (!targets) return;
      // Iterated live rather than copied: a sink can only unsubscribe itself
      // from here, which a Set tolerates mid-iteration.
      for (const target of targets) target.onData(data);
    });
    const offExit = onProcessedPtyExit((id, exitCode) => {
      const targets = streams.get(id);
      if (!targets) return;
      // Dropped before the fan-out, so a sink that unsubscribes from inside its
      // own `onExit` finds nothing left to take out — and so a re-subscribe
      // during the fan-out keeps the listener pair rather than losing it below.
      streams.delete(id);
      for (const target of targets) target.onExit(exitCode);
      uninstallIfIdle();
    });
    stopListeners = () => {
      offData();
      offExit();
    };
  };

  return {
    streamPty(ptyId, sink) {
      let sinks = streams.get(ptyId);
      if (!sinks) {
        sinks = new Set();
        streams.set(ptyId, sinks);
      }
      const subscribed = sinks;
      subscribed.add(sink);
      install();

      return () => {
        // Only if the map still holds the very set this subscription joined: an
        // exit replaces nothing but does remove it, and a later attachment to
        // the same id gets a fresh one that this unsubscribe has no claim on.
        if (streams.get(ptyId) !== subscribed) return;
        subscribed.delete(sink);
        if (subscribed.size > 0) return;
        streams.delete(ptyId);
        uninstallIfIdle();
      };
    },
  };
}

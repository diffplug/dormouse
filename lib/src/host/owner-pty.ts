import type { AlertManager } from '../lib/alert-manager';
import {
  createProcessedPtyStream,
  type ProcessedPtyChunk,
  type ProcessedPtyStream,
} from '../lib/processed-pty-stream';
import {
  applyTerminalEvents,
  collectTerminalProtocolResponses,
  collectTerminalToolEvents,
  type TerminalColorProvider,
  type TerminalProtocolEvent,
} from '../lib/terminal-protocol';
import type { TerminalSemanticEvent } from '../lib/terminal-state';

/**
 * What the process that owns a PTY does with it on behalf of its alerts, the
 * same in both hosts: VS Code's extension host (`vscode-ext/src/message-router.ts`)
 * and standalone's sidecar (`lib/src/host/remote/sidecar-entry.ts`).
 */

export interface OwnerPtyStreamOptions {
  /** The host's one manager (`lib/src/host/alert-host.ts`). */
  alerts: AlertManager;
  colorProvider: TerminalColorProvider;
  /** The Tool announcements, state and command-start resets of one parse, in
   *  stream order, for the renderer that holds the Tool stores. */
  onToolEvents(events: TerminalProtocolEvent[]): void;
  /** The timestamped semantic events of one parse, for the renderer's
   *  terminal-state store. */
  onSemanticEvents(events: TerminalSemanticEvent[]): void;
  /** A reply to a query. Written by the owner alone, never a viewer: it is the
   *  sole reply authority (`docs/specs/remote-api.md` → Terminal surfaces). */
  writeResponse(data: string): void;
  /** One chunk of visible output, for the owner's renderer. */
  onChunk(chunk: ProcessedPtyChunk): void;
}

/**
 * One PTY generation's parse site, feeding the alerts and the renderer from the
 * same pass: per batch, reports and command boundaries to the manager in stream
 * order (`applyTerminalEvents`), then the Tool and semantic events, then the
 * replies; then each visible chunk counts as the Session working, ahead of the
 * renderer (`docs/specs/terminal-escapes.md` → "Parsing location").
 */
export function createOwnerPtyStream(id: string, options: OwnerPtyStreamOptions): ProcessedPtyStream {
  return createProcessedPtyStream({
    colorProvider: options.colorProvider,
    onEvents(events) {
      const semanticEvents = applyTerminalEvents(options.alerts, id, events);
      const toolEvents = collectTerminalToolEvents(events);
      if (toolEvents.length > 0) options.onToolEvents(toolEvents);
      if (semanticEvents.length > 0) options.onSemanticEvents(semanticEvents);
      for (const response of collectTerminalProtocolResponses(events)) options.writeResponse(response);
    },
    onChunk(chunk) {
      options.alerts.onData(id);
      options.onChunk(chunk);
    },
  });
}

/** The slice of a host's PTY manager that input and size changes reach. */
export interface PtyWriteTarget {
  write(id: string, data: string, options?: { paced?: boolean }): void;
  resize(id: string, cols: number, rows: number, repaint?: boolean): void;
}

/**
 * A host's PTY writes and resizes as its alerts must see them, whoever asked —
 * a local renderer or a remote Client: **human input is acknowledged, echo
 * window opened, before its bytes reach the PTY**, and a resize opens its grace
 * window before the program repaints (`docs/specs/alert.md` → Engagement).
 */
export function alertedPty(alerts: AlertManager, pty: PtyWriteTarget) {
  return {
    write(id: string, data: string, options: { paced?: boolean; userInput?: boolean } = {}): void {
      if (options.userInput) alerts.acknowledge(id, { input: true });
      pty.write(id, data, options.paced ? { paced: true } : undefined);
    },
    resize(id: string, cols: number, rows: number, repaint?: boolean): void {
      alerts.onResize(id);
      pty.resize(id, cols, rows, repaint);
    },
  };
}

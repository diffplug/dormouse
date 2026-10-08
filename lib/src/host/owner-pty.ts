import type { AlertManager } from '../lib/alert-manager';
import {
  createProcessedPtyStream,
  type ProcessedPtyChunk,
  type ProcessedPtyStream,
} from '../lib/processed-pty-stream';
import {
  applyTerminalEvents,
  collectTerminalClipboardOffers,
  collectTerminalProtocolResponses,
  collectTerminalToolEvents,
  type TerminalColorProvider,
  type TerminalProtocolEvent,
} from '../lib/terminal-protocol';
import type { TerminalSemanticEvent } from '../lib/terminal-state';
import { ToolLaunchLatch } from '../lib/tool-launch-latch';
import { stripMouseReportsFromInput } from '../lib/terminal-report-filter';

/**
 * What the process that owns a PTY does with it on behalf of its alerts, the
 * same in both hosts: VS Code's extension host (`vscode-ext/src/message-router.ts`)
 * and standalone's sidecar (`lib/src/host/remote/sidecar-entry.ts`).
 */

export interface OwnerPtyStreamOptions {
  /** The host's one manager (`lib/src/host/alert-host.ts`). */
  alerts: AlertManager;
  colorProvider: TerminalColorProvider;
  /** The Tool announcements, state, admitted `open` requests and command-start
   *  resets of one parse, in stream order, for the renderer that holds the Tool
   *  stores. */
  onToolEvents(events: TerminalProtocolEvent[]): void;
  /** The timestamped semantic events of one parse, for the renderer's
   *  terminal-state store. */
  onSemanticEvents(events: TerminalSemanticEvent[]): void;
  /** A reply to a query. Written by the owner alone, never a viewer: it is the
   *  sole reply authority (`docs/specs/remote-api.md` → Terminal surfaces). */
  writeResponse(data: string): void;
  /** An `OSC 52` write, for the renderer's copy editor to offer — never the
   *  clipboard (`docs/specs/mouse-and-clipboard.md` §4.6). */
  onClipboardOffer(text: string): void;
  /** One chunk of visible output, for the owner's renderer. */
  onChunk(chunk: ProcessedPtyChunk): void;
}

export interface OwnerPtyStream extends ProcessedPtyStream {
  /** The host is typing `typed` into this PTY generation to run it: that run
   *  alone may make OSC 367 `open` requests (`ToolLaunchLatch`). */
  armLaunch(typed: string): void;
}

/**
 * One PTY generation's parse site, feeding the alerts and the renderer from the
 * same pass: per batch, reports and command boundaries to the manager in stream
 * order (`applyTerminalEvents`), then the Tool and semantic events, then the
 * replies; then each visible chunk counts as the Session working, ahead of the
 * renderer (`docs/specs/terminal-escapes.md` → "Parsing location").
 */
export function createOwnerPtyStream(id: string, options: OwnerPtyStreamOptions): OwnerPtyStream {
  const launch = new ToolLaunchLatch();
  const stream = createProcessedPtyStream({
    colorProvider: options.colorProvider,
    onEvents(events) {
      const semanticEvents = applyTerminalEvents(options.alerts, id, events);
      const toolEvents = collectTerminalToolEvents(launch.admit(events));
      if (toolEvents.length > 0) options.onToolEvents(toolEvents);
      if (semanticEvents.length > 0) options.onSemanticEvents(semanticEvents);
      for (const response of collectTerminalProtocolResponses(events)) options.writeResponse(response);
      for (const text of collectTerminalClipboardOffers(events)) options.onClipboardOffer(text);
    },
    onChunk(chunk) {
      options.alerts.onData(id);
      options.onChunk(chunk);
    },
  });
  return Object.assign(stream, { armLaunch: (typed: string) => launch.arm(typed) });
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
  const write = (id: string, data: string, options: { paced?: boolean; userInput?: boolean } = {}): void => {
    if (options.userInput) alerts.acknowledge(id, { input: true });
    pty.write(id, data, options.paced ? { paced: true } : undefined);
  };
  return {
    write,
    /**
     * A remote Client's write, the Burrow having dropped a mirror's terminal
     * replies: human input unless it holds only mouse reports, which a Client
     * sends unmarked and the desktop never acknowledges.
     */
    writeClientInput(id: string, data: string): void {
      write(id, data, { userInput: stripMouseReportsFromInput(data).length > 0 });
    },
    resize(id: string, cols: number, rows: number, repaint?: boolean): void {
      alerts.onResize(id);
      pty.resize(id, cols, rows, repaint);
    },
  };
}

/**
 * Remote-api v1, terminal-only (remote-api.md → "v1 scope"). One
 * {@link RemoteApiSession} per authorized Client session translates the wire
 * protocol into the Host's existing terminal plumbing:
 *
 *   - `hello`           → capabilities (input yes, layout no).
 *   - `directory.watch` → an immediate snapshot plus coalesced re-snapshots
 *                         whenever pane state / activity / focus changes.
 *   - `surface.attach`  → resize the real PTY through the existing xterm resize
 *                         path (attach-is-the-resize) and stream its output as
 *                         `terminal.data`; `terminal.closed` on PTY exit.
 *   - `terminal.write`  → the existing PTY input path.
 *   - `terminal.resize` → take size authority (last-attach-wins).
 *   - `surface.detach`  → stop streaming.
 *
 * The bytes on the wire are base64url PTY bytes; xterm on the Client renders
 * them, exactly as the Host's own xterm renders the same stream locally.
 */

import {
  REMOTE_EVENTS,
  REMOTE_METHODS,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type AttachParams,
  type HelloResult,
  type RemoteEventMsg,
  type RemoteRequest,
  type RemoteResponse,
  type TerminalAttachResult,
  type TerminalResizeParams,
  type TerminalWriteParams,
} from 'server-lib-common';
import { getPlatform } from '../../lib/platform';
import { registry } from '../../lib/terminal-store';
import { subscribeToActivity } from '../../lib/session-activity-store';
import { subscribeToTerminalPaneState } from '../../lib/terminal-state-store';
import { collectDirectorySnapshot } from './directory-collect';

/** Coalesce window for directory re-snapshots (remote-api.md: "Host coalesces"). */
const DIRECTORY_DEBOUNCE_MS = 150;
/**
 * When an attach requests the size the PTY already has, `terminal.resize` is a
 * no-op, so we bounce the PTY's rows to force one SIGWINCH-driven repaint.
 */
const FORCE_REPAINT_BOUNCE_MS = 60;

interface Attachment {
  surfaceId: string;
  ptyId: string;
  subId: string;
  onData: (detail: { id: string; data: string }) => void;
  onExit: (detail: { id: string; exitCode: number }) => void;
}

export interface RemoteApiSessionOptions {
  hostId: string;
  /** Sends a remote-api response/event; the caller wraps it in a `msg` frame. */
  send: (payload: RemoteResponse | RemoteEventMsg) => void;
}

export class RemoteApiSession {
  readonly #hostId: string;
  readonly #send: (payload: RemoteResponse | RemoteEventMsg) => void;

  #directorySubId: string | null = null;
  #unsubDirectory: (() => void) | null = null;
  #directoryTimer: ReturnType<typeof setTimeout> | null = null;
  #attachment: Attachment | null = null;

  constructor(options: RemoteApiSessionOptions) {
    this.#hostId = options.hostId;
    this.#send = options.send;
  }

  handle(data: unknown): void {
    const request = data as RemoteRequest;
    if (!request || typeof request.requestId !== 'string' || typeof request.method !== 'string') {
      return;
    }
    try {
      switch (request.method) {
        case REMOTE_METHODS.hello:
          return this.#hello(request);
        case REMOTE_METHODS.directoryWatch:
          return this.#directoryWatch(request);
        case REMOTE_METHODS.surfaceAttach:
          return this.#attach(request);
        case REMOTE_METHODS.surfaceDetach:
          return this.#detach(request);
        case REMOTE_METHODS.terminalWrite:
          return this.#write(request);
        case REMOTE_METHODS.terminalResize:
          return this.#resize(request);
        default:
          return this.#fail(request, `unknown method: ${request.method}`);
      }
    } catch (error) {
      this.#fail(request, error instanceof Error ? error.message : 'internal error');
    }
  }

  dispose(): void {
    this.#directorySubId = null;
    if (this.#directoryTimer) {
      clearTimeout(this.#directoryTimer);
      this.#directoryTimer = null;
    }
    this.#unsubDirectory?.();
    this.#unsubDirectory = null;
    this.#teardownAttachment();
  }

  // --- Responses ---

  #ok(request: RemoteRequest, result: unknown): void {
    this.#send({ requestId: request.requestId, ok: true, result });
  }

  #fail(request: RemoteRequest, error: string): void {
    this.#send({ requestId: request.requestId, ok: false, error });
  }

  #event(subId: string, event: string, data: unknown): void {
    this.#send({ subId, event, data });
  }

  // --- Methods ---

  #hello(request: RemoteRequest): void {
    // v1 selfhost: every paired session is the owner, so full input, no layout.
    const result: HelloResult = {
      protocolVersion: 1,
      hostId: this.#hostId,
      grants: { input: true, layout: false },
    };
    this.#ok(request, result);
  }

  #directoryWatch(request: RemoteRequest): void {
    // The subscription id the client correlates snapshots by is this request id.
    this.#directorySubId = request.requestId;
    this.#ok(request, { subId: request.requestId });
    this.#emitDirectory();

    if (this.#unsubDirectory) return;
    const trigger = () => this.#scheduleDirectory();
    const unsubPane = subscribeToTerminalPaneState(trigger);
    const unsubActivity = subscribeToActivity(trigger);
    const hasDocument = typeof document !== 'undefined';
    if (hasDocument) {
      document.addEventListener('focusin', trigger);
      document.addEventListener('focusout', trigger);
    }
    this.#unsubDirectory = () => {
      unsubPane();
      unsubActivity();
      if (hasDocument) {
        document.removeEventListener('focusin', trigger);
        document.removeEventListener('focusout', trigger);
      }
    };
  }

  #scheduleDirectory(): void {
    if (this.#directorySubId === null || this.#directoryTimer) return;
    this.#directoryTimer = setTimeout(() => {
      this.#directoryTimer = null;
      this.#emitDirectory();
    }, DIRECTORY_DEBOUNCE_MS);
  }

  #emitDirectory(): void {
    if (this.#directorySubId === null) return;
    this.#event(this.#directorySubId, REMOTE_EVENTS.directorySnapshot, {
      entries: collectDirectorySnapshot(),
    });
  }

  #attach(request: RemoteRequest): void {
    const params = request.params as AttachParams | undefined;
    const entry = params ? registry.get(params.surfaceId) : undefined;
    if (!params || !entry) {
      return this.#fail(request, `no such surface: ${params?.surfaceId ?? '(none)'}`);
    }
    // v1: one attachment per session — replace any prior stream.
    this.#teardownAttachment();

    const ptyId = entry.ptyId;
    const term = entry.terminal;
    const cols = clampDimension(params.cols, term.cols);
    const rows = clampDimension(params.rows, term.rows);
    const platform = getPlatform();

    // Attach-is-the-resize: resizing the real xterm fires its onResize handler,
    // which drives resizePty → SIGWINCH → the TUI/shell repaints, and that
    // repaint is what fills the client's screen (no snapshot transfer).
    if (term.cols !== cols || term.rows !== rows) {
      term.resize(cols, rows);
    } else {
      // Same size: force one repaint with a quick rows bounce on the PTY only,
      // leaving the already-correct local xterm buffer untouched.
      platform.resizePty(ptyId, cols, Math.max(1, rows - 1));
      setTimeout(() => platform.resizePty(ptyId, cols, rows), FORCE_REPAINT_BOUNCE_MS);
    }

    const subId = request.requestId;
    const onData = (detail: { id: string; data: string }): void => {
      if (detail.id !== ptyId) return;
      // The PTY delivers strings on this path; be defensive about the Uint8Array
      // path some adapters use. Either way it goes out as base64url PTY bytes.
      const raw: unknown = detail.data;
      const bytes = typeof raw === 'string' ? utf8Encode(raw) : (raw as Uint8Array);
      this.#event(subId, REMOTE_EVENTS.terminalData, { bytes: toBase64Url(bytes) });
    };
    const onExit = (detail: { id: string; exitCode: number }): void => {
      if (detail.id !== ptyId) return;
      this.#event(subId, REMOTE_EVENTS.terminalClosed, { exitCode: detail.exitCode });
    };
    platform.onPtyData(onData);
    platform.onPtyExit(onExit);
    this.#attachment = { surfaceId: params.surfaceId, ptyId, subId, onData, onExit };

    const result: TerminalAttachResult = { cols: term.cols, rows: term.rows };
    this.#ok(request, result);
  }

  #detach(request: RemoteRequest): void {
    this.#teardownAttachment();
    this.#ok(request, {});
  }

  #write(request: RemoteRequest): void {
    const params = request.params as TerminalWriteParams | undefined;
    const entry = params ? registry.get(params.surfaceId) : undefined;
    if (!params || !entry) {
      return this.#fail(request, `no such surface: ${params?.surfaceId ?? '(none)'}`);
    }
    // Feed the existing PTY input path; the local echo returns via onPtyData.
    getPlatform().writePty(entry.ptyId, utf8Decode(fromBase64Url(params.bytes)));
    this.#ok(request, {});
  }

  #resize(request: RemoteRequest): void {
    const params = request.params as TerminalResizeParams | undefined;
    const entry = params ? registry.get(params.surfaceId) : undefined;
    if (!params || !entry) {
      return this.#fail(request, `no such surface: ${params?.surfaceId ?? '(none)'}`);
    }
    const term = entry.terminal;
    const cols = clampDimension(params.cols, term.cols);
    const rows = clampDimension(params.rows, term.rows);
    if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
    const result: TerminalAttachResult = { cols: term.cols, rows: term.rows };
    this.#ok(request, result);
  }

  #teardownAttachment(): void {
    if (!this.#attachment) return;
    const platform = getPlatform();
    platform.offPtyData(this.#attachment.onData);
    platform.offPtyExit(this.#attachment.onExit);
    this.#attachment = null;
  }
}

function clampDimension(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

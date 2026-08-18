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
  clampTerminalDimension,
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
import type { TerminalEntry } from '../../lib/terminal-store';
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

/**
 * Where an attached surface lives. A window's terminals are spread across its
 * webviews and only one of them is the Host, so an attachment is either to a
 * pane in this webview's registry or to one a sibling owns, driven through the
 * peer bridge (docs/specs/vscode.md → "Peer surfaces").
 */
type SurfaceTarget =
  | { kind: 'local'; entry: TerminalEntry }
  | { kind: 'peer'; surfaceId: string; cols: number; rows: number };

function targetSize(target: SurfaceTarget): { cols: number; rows: number } {
  return target.kind === 'local'
    ? { cols: target.entry.terminal.cols, rows: target.entry.terminal.rows }
    : { cols: target.cols, rows: target.rows };
}

interface Attachment {
  surfaceId: string;
  ptyId: string;
  target: SurfaceTarget;
  subId: string;
  onData: (detail: { id: string; data: string }) => void;
  onExit: (detail: { id: string; exitCode: number }) => void;
  /** Pending same-size repaint bounce (see FORCE_REPAINT_BOUNCE_MS), if any. */
  bounceTimer: ReturnType<typeof setTimeout> | null;
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

  #requireAttached(request: RemoteRequest, surfaceId: string): Attachment | null {
    if (this.#attachment?.surfaceId === surfaceId) return this.#attachment;
    this.#fail(request, `surface is not attached: ${surfaceId}`);
    return null;
  }

  #attachedParams<P extends { surfaceId: string }>(
    request: RemoteRequest,
  ): { params: P; attachment: Attachment } | null {
    const params = request.params as P | undefined;
    if (!params || typeof params.surfaceId !== 'string') {
      this.#fail(request, `no such surface: ${params?.surfaceId ?? '(none)'}`);
      return null;
    }
    const attachment = this.#requireAttached(request, params.surfaceId);
    return attachment ? { params, attachment } : null;
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
    const subId = this.#directorySubId;
    const local = collectDirectorySnapshot();
    const peers = getPlatform().peers;
    if (!peers) {
      this.#event(subId, REMOTE_EVENTS.directorySnapshot, { entries: local });
      return;
    }
    // A window's terminals are spread across its webviews, and only this one is
    // the Host — the rest have to be asked (docs/specs/vscode.md → "Peer
    // surfaces"). Emit twice rather than delaying the local panes behind a
    // round trip: the phone renders what is here immediately, then fills in.
    this.#event(subId, REMOTE_EVENTS.directorySnapshot, { entries: local });
    void peers.directory().then((remote) => {
      // The subscription may have been replaced or torn down while we waited.
      if (this.#directorySubId !== subId || remote.length === 0) return;
      this.#event(subId, REMOTE_EVENTS.directorySnapshot, {
        entries: [...collectDirectorySnapshot(), ...remote],
      });
    });
  }

  #attach(request: RemoteRequest): void {
    const params = request.params as AttachParams | undefined;
    if (!params?.surfaceId) {
      this.#fail(request, `no such surface: ${params?.surfaceId ?? '(none)'}`);
      return;
    }

    const entry = registry.get(params.surfaceId);
    if (entry) {
      this.#beginAttach(request, params, { kind: 'local', entry }, entry.ptyId);
      return;
    }

    // Not ours: ask the other webviews of this window. The owner resizes its
    // own xterm — attach-is-the-resize has to go through the live terminal, not
    // the PTY, or the owning pane's view drifts from the size the phone set.
    const peers = getPlatform().peers;
    if (!peers) {
      this.#fail(request, `no such surface: ${params.surfaceId}`);
      return;
    }
    void peers.surfaceOp(params.surfaceId, 'attach', params.cols, params.rows).then((result) => {
      if (!result.ok || !result.ptyId) {
        this.#fail(request, `no such surface: ${params.surfaceId}`);
        return;
      }
      peers.subscribePty(result.ptyId);
      this.#beginAttach(
        request,
        params,
        {
          kind: 'peer',
          surfaceId: params.surfaceId,
          cols: result.cols ?? 0,
          rows: result.rows ?? 0,
        },
        result.ptyId,
      );
    });
  }

  #beginAttach(
    request: RemoteRequest,
    params: AttachParams,
    target: SurfaceTarget,
    ptyId: string,
  ): void {
    // v1: one attachment per session — replace any prior stream.
    this.#teardownAttachment();

    const current = targetSize(target);
    const cols = clampTerminalDimension(params.cols, current.cols);
    const rows = clampTerminalDimension(params.rows, current.rows);
    const platform = getPlatform();
    const subId = request.requestId;
    const pendingEvents: Array<{ event: string; data: unknown }> = [];
    let streaming = false;
    const emitOrBuffer = (event: string, data: unknown): void => {
      if (streaming) {
        this.#event(subId, event, data);
      } else {
        pendingEvents.push({ event, data });
      }
    };
    const onData = (detail: { id: string; data: string }): void => {
      if (detail.id !== ptyId) return;
      // The PTY delivers strings on this path; be defensive about the Uint8Array
      // path some adapters use. Either way it goes out as base64url PTY bytes.
      const raw: unknown = detail.data;
      const bytes = typeof raw === 'string' ? utf8Encode(raw) : (raw as Uint8Array);
      emitOrBuffer(REMOTE_EVENTS.terminalData, { bytes: toBase64Url(bytes) });
    };
    const onExit = (detail: { id: string; exitCode: number }): void => {
      if (detail.id !== ptyId) return;
      // Deliver the close to the client first, then drop the attachment so a
      // later write/resize for this surface fails safe with "not attached"
      // instead of touching the now-dead PTY / disposed xterm (the pre-pin code
      // re-resolved via the registry and got that fail-safe for free). Teardown
      // offPtyExit(onExit)s mid-callback, which is safe — this handler, having
      // filtered to its own ptyId, won't fire again — and nulls #attachment so
      // #requireAttached fails and the bounce timer + PTY listeners are cleaned.
      emitOrBuffer(REMOTE_EVENTS.terminalClosed, { exitCode: detail.exitCode });
      this.#teardownAttachment();
    };
    platform.onPtyData(onData);
    platform.onPtyExit(onExit);
    const attachment: Attachment = {
      surfaceId: params.surfaceId,
      ptyId,
      target,
      subId,
      onData,
      onExit,
      bounceTimer: null,
    };
    this.#attachment = attachment;

    // Attach-is-the-resize: resizing the real xterm fires its onResize handler,
    // which drives resizePty → SIGWINCH → the TUI/shell repaints, and that
    // repaint is what fills the client's screen (no snapshot transfer). The
    // stream is subscribed first because some PTYs repaint synchronously.
    // A peer owner already applied the size in its own xterm before replying,
    // so only the local path still has a resize to perform here.
    const sized = targetSize(target);
    if (sized.cols !== cols || sized.rows !== rows) {
      if (target.kind === 'local') target.entry.terminal.resize(cols, rows);
      else void this.#resizePeer(target, cols, rows);
    } else {
      // Same size: force one repaint with a quick rows bounce on the PTY only,
      // leaving the already-correct local xterm buffer untouched. Bounce away
      // from `rows` in whichever direction stays >= 1 (a 1-row surface must
      // bounce up, since rows-1 would be an identical no-op that fires no
      // SIGWINCH and so never repaints).
      const bounced = rows > 1 ? rows - 1 : rows + 1;
      platform.resizePty(ptyId, cols, bounced);
      // The restore runs ~60ms later, so the client may detach, re-attach at a
      // different size, or dispose the session first. Cancel on teardown and,
      // as a backstop, re-check this is still the current attachment before
      // touching the PTY — a stale restore would clobber the newer size owner
      // (last-attach-wins) or resize a detached/exited PTY.
      attachment.bounceTimer = setTimeout(() => {
        attachment.bounceTimer = null;
        if (this.#attachment !== attachment) return;
        platform.resizePty(ptyId, cols, rows);
      }, FORCE_REPAINT_BOUNCE_MS);
    }

    const settled = targetSize(target);
    const result: TerminalAttachResult = { cols: settled.cols, rows: settled.rows };
    this.#ok(request, result);
    streaming = true;
    for (const event of pendingEvents) {
      this.#event(subId, event.event, event.data);
    }
  }

  #detach(request: RemoteRequest): void {
    // Detach names its surface: a stale detach for a pane the client already
    // switched away from must not kill the newer attachment. Detaching a
    // surface that is not the current attachment is an idempotent no-op.
    const params = request.params as { surfaceId?: string } | undefined;
    if (this.#attachment && this.#attachment.surfaceId === params?.surfaceId) {
      this.#teardownAttachment();
    }
    this.#ok(request, {});
  }

  #write(request: RemoteRequest): void {
    const resolved = this.#attachedParams<TerminalWriteParams>(request);
    if (!resolved) return;
    const { params, attachment } = resolved;
    // Feed the existing PTY input path; the local echo returns via onPtyData.
    getPlatform().writePty(attachment.ptyId, utf8Decode(fromBase64Url(params.bytes)));
    this.#ok(request, {});
  }

  #resize(request: RemoteRequest): void {
    const resolved = this.#attachedParams<TerminalResizeParams>(request);
    if (!resolved) return;
    const { params, attachment } = resolved;
    const target = attachment.target;
    const current = targetSize(target);
    const cols = clampTerminalDimension(params.cols, current.cols);
    const rows = clampTerminalDimension(params.rows, current.rows);

    if (target.kind === 'local') {
      const term = target.entry.terminal;
      if (term.cols !== cols || term.rows !== rows) term.resize(cols, rows);
      this.#ok(request, { cols: term.cols, rows: term.rows } satisfies TerminalAttachResult);
      return;
    }

    void this.#resizePeer(target, cols, rows).then((size) => {
      this.#ok(request, { cols: size.cols, rows: size.rows } satisfies TerminalAttachResult);
    });
  }

  /**
   * Resize a sibling-owned surface and record the size it settled at, so
   * `targetSize` keeps answering for the pane we cannot read directly.
   */
  async #resizePeer(
    target: Extract<SurfaceTarget, { kind: 'peer' }>,
    cols: number,
    rows: number,
  ): Promise<{ cols: number; rows: number }> {
    const peers = getPlatform().peers;
    const result = await peers?.surfaceOp(target.surfaceId, 'resize', cols, rows);
    if (result?.ok) {
      target.cols = result.cols ?? cols;
      target.rows = result.rows ?? rows;
    }
    return { cols: target.cols, rows: target.rows };
  }

  #teardownAttachment(): void {
    if (!this.#attachment) return;
    if (this.#attachment.bounceTimer) {
      clearTimeout(this.#attachment.bounceTimer);
      this.#attachment.bounceTimer = null;
    }
    const platform = getPlatform();
    platform.offPtyData(this.#attachment.onData);
    platform.offPtyExit(this.#attachment.onExit);
    // Stop the host forwarding a PTY this webview never owned.
    if (this.#attachment.target.kind === 'peer') {
      platform.peers?.unsubscribePty(this.#attachment.ptyId);
    }
    this.#attachment = null;
  }
}

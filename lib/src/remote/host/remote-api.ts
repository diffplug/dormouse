/**
 * Remote-api v1, terminal-only (remote-api.md → "v1 scope"). One
 * {@link RemoteApiSession} per authorized Client session translates the wire
 * protocol into the Host's existing terminal plumbing:
 *
 *   - `hello`           → capabilities (input yes, layout no).
 *   - `directory.watch` → an immediate snapshot plus coalesced re-snapshots
 *                         whenever the provider says the directory could differ.
 *   - `surface.attach`  → resize the real PTY through the existing xterm resize
 *                         path (attach-is-the-resize) and stream its output as
 *                         `terminal.data`; `terminal.closed` on PTY exit.
 *   - `terminal.write`  → the existing PTY input path.
 *   - `terminal.resize` → take size authority (last-attach-wins).
 *   - `surface.detach`  → stop streaming.
 *
 * The bytes on the wire are base64url PTY bytes; xterm on the Client renders
 * them, exactly as the Host's own xterm renders the same stream locally.
 *
 * Everything below the protocol — where a surface lives, how a PTY is read and
 * written — is a {@link HostSurfaceProvider} call, so this module is
 * environment-free: it never reaches for the platform adapter, the stores, or
 * `document`, and runs unchanged in a webview or in the process that owns the
 * PTYs (`host-surface-provider.ts`).
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
import type { HostSurfaceProvider, SurfaceHandle } from './host-surface-provider';

/** Coalesce window for directory re-snapshots (remote-api.md: "Host coalesces"). */
const DIRECTORY_DEBOUNCE_MS = 150;
/**
 * When an attach requests the size the PTY already has, `terminal.resize` is a
 * no-op, so we bounce the PTY's rows to force one SIGWINCH-driven repaint.
 */
const FORCE_REPAINT_BOUNCE_MS = 60;

interface Attachment {
  surfaceId: string;
  /**
   * The resolved surface. Pinned at attach — a pane swap must not move the
   * attachment onto a different terminal — and it is the only thing here that
   * knows where the pane actually lives (`host-surface-provider.ts`).
   */
  handle: SurfaceHandle;
  subId: string;
  /** Unsubscribes this attachment's PTY stream; nobody else holds it. */
  stopStream: () => void;
  /** Pending same-size repaint bounce (see FORCE_REPAINT_BOUNCE_MS), if any. */
  bounceTimer: ReturnType<typeof setTimeout> | null;
}

export interface RemoteApiSessionOptions {
  hostId: string;
  /** Sends a remote-api response/event; the caller wraps it in a `msg` frame. */
  send: (payload: RemoteResponse | RemoteEventMsg) => void;
  /** Everything below the protocol: where surfaces live, and how PTYs are driven. */
  provider: HostSurfaceProvider;
}

export class RemoteApiSession {
  readonly #hostId: string;
  readonly #send: (payload: RemoteResponse | RemoteEventMsg) => void;
  readonly #provider: HostSurfaceProvider;

  #directorySubId: string | null = null;
  #unsubDirectory: (() => void) | null = null;
  #directoryTimer: ReturnType<typeof setTimeout> | null = null;
  #attachment: Attachment | null = null;
  #attachGeneration = 0;
  #disposed = false;

  constructor(options: RemoteApiSessionOptions) {
    this.#hostId = options.hostId;
    this.#send = options.send;
    this.#provider = options.provider;
  }

  handle(data: unknown): void {
    if (this.#disposed) return;
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
    if (this.#disposed) return;
    this.#disposed = true;
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
    void this.#emitDirectory();

    if (this.#unsubDirectory) return;
    this.#unsubDirectory = this.#provider.watchDirectory(() => this.#scheduleDirectory());
  }

  #scheduleDirectory(): void {
    if (this.#directorySubId === null || this.#directoryTimer) return;
    this.#directoryTimer = setTimeout(() => {
      this.#directoryTimer = null;
      void this.#emitDirectory();
    }, DIRECTORY_DEBOUNCE_MS);
  }

  async #emitDirectory(): Promise<void> {
    if (this.#directorySubId === null) return;
    const subId = this.#directorySubId;
    // One snapshot per collect. The provider answers for every surface the Host
    // can reach, so there is no longer a subset that is known sooner than the
    // rest — this replaces the old local-then-merged double emit, which existed
    // only because the peer round trip was visible from here.
    const entries = await this.#provider.collectDirectory();
    // The subscription may have been replaced or torn down while we waited.
    if (this.#directorySubId !== subId) return;
    this.#event(subId, REMOTE_EVENTS.directorySnapshot, { entries });
  }

  #attach(request: RemoteRequest): void {
    const params = request.params as AttachParams | undefined;
    if (!params?.surfaceId) {
      this.#fail(request, `no such surface: ${params?.surfaceId ?? '(none)'}`);
      return;
    }

    // Where the pane lives — a registry here or an owner a round trip away — is
    // a deployment fact, not a protocol concept, so it is settled below this
    // line and never seen here (`host-surface-provider.ts`).
    //
    // Per attach, not per session: last-attach-wins has to hold while a
    // resolve is in flight, and the two paths are wildly different lengths — a
    // sibling's pane is a round trip away while a local one settles on the next
    // microtask, so one shared epoch would let the older, slower attach land
    // last and take the attachment.
    const generation = ++this.#attachGeneration;
    void this.#provider.resolveSurface(params.surfaceId, params).then((handle) => {
      if (this.#disposed || this.#attachGeneration !== generation) {
        // A foreign resolve starts its stream before returning the handle. If
        // the session died or a newer attach superseded this one during that
        // round trip, unwind it immediately.
        handle?.release();
        // The client holds a request pending until it is answered, so a
        // superseded attach is failed rather than dropped — that also drops its
        // event subscription. A disposed session has no transport to answer on.
        if (!this.#disposed) {
          this.#fail(request, `superseded by a newer attach: ${params.surfaceId}`);
        }
        return;
      }
      if (!handle) {
        this.#fail(request, `no such surface: ${params.surfaceId}`);
        return;
      }
      this.#beginAttach(request, params, handle);
    });
  }

  #beginAttach(request: RemoteRequest, params: AttachParams, handle: SurfaceHandle): void {
    // v1: one attachment per session — replace any prior stream.
    this.#teardownAttachment();

    const ptyId = handle.ptyId;
    const cols = clampTerminalDimension(params.cols, handle.cols);
    const rows = clampTerminalDimension(params.rows, handle.rows);
    const sameSize = handle.cols === cols && handle.rows === rows;
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
    const stopStream = this.#provider.streamPty(ptyId, {
      onData: (data) => {
        // The PTY delivers strings on this path; be defensive about the
        // Uint8Array path some adapters use. Either way it goes out as
        // base64url PTY bytes.
        const raw: unknown = data;
        const bytes = typeof raw === 'string' ? utf8Encode(raw) : (raw as Uint8Array);
        emitOrBuffer(REMOTE_EVENTS.terminalData, { bytes: toBase64Url(bytes) });
      },
      onExit: (exitCode) => {
        // Deliver the close to the client first, then drop the attachment so a
        // later write/resize for this surface fails safe with "not attached"
        // instead of touching the now-dead PTY / disposed xterm (the pre-pin
        // code re-resolved via the registry and got that fail-safe for free).
        // Teardown unsubscribes this stream mid-callback, which is safe — the
        // subscription is this attachment's alone, so nothing is left to fire —
        // and nulls #attachment so #requireAttached fails and the bounce timer
        // is cleared.
        emitOrBuffer(REMOTE_EVENTS.terminalClosed, { exitCode });
        this.#teardownAttachment();
      },
    });
    const attachment: Attachment = {
      surfaceId: params.surfaceId,
      handle,
      subId,
      stopStream,
      bounceTimer: null,
    };
    this.#attachment = attachment;

    // Attach-is-the-resize: resizing the real xterm fires its onResize handler,
    // which drives resizePty → SIGWINCH → the TUI/shell repaints, and that
    // repaint is what fills the client's screen (no snapshot transfer). The
    // stream is subscribed first because some PTYs repaint synchronously.
    // A sibling's owner already applied the size inside the attach round trip,
    // so its handle resolves at the requested size and takes the bounce below.
    if (!sameSize) {
      void handle.resize(cols, rows);
    } else {
      // Same size: force one repaint with a quick rows bounce on the PTY only,
      // leaving the already-correct local xterm buffer untouched. Bounce away
      // from `rows` in whichever direction stays >= 1 (a 1-row surface must
      // bounce up, since rows-1 would be an identical no-op that fires no
      // SIGWINCH and so never repaints).
      const bounced = rows > 1 ? rows - 1 : rows + 1;
      this.#provider.resizePty(ptyId, cols, bounced);
      // The restore runs ~60ms later, so the client may detach, re-attach at a
      // different size, or dispose the session first. Cancel on teardown and,
      // as a backstop, re-check this is still the current attachment before
      // touching the PTY — a stale restore would clobber the newer size owner
      // (last-attach-wins) or resize a detached/exited PTY.
      attachment.bounceTimer = setTimeout(() => {
        attachment.bounceTimer = null;
        if (this.#attachment !== attachment) return;
        this.#provider.resizePty(ptyId, cols, rows);
      }, FORCE_REPAINT_BOUNCE_MS);
    }

    const result: TerminalAttachResult = { cols: handle.cols, rows: handle.rows };
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
    // Feed the existing PTY input path; the local echo returns via the stream.
    this.#provider.writePty(attachment.handle.ptyId, utf8Decode(fromBase64Url(params.bytes)));
    this.#ok(request, {});
  }

  #resize(request: RemoteRequest): void {
    const resolved = this.#attachedParams<TerminalResizeParams>(request);
    if (!resolved) return;
    const { params, attachment } = resolved;
    const handle = attachment.handle;
    const cols = clampTerminalDimension(params.cols, handle.cols);
    const rows = clampTerminalDimension(params.rows, handle.rows);

    void handle.resize(cols, rows).then((size) => {
      this.#ok(request, { cols: size.cols, rows: size.rows } satisfies TerminalAttachResult);
    });
  }

  #teardownAttachment(): void {
    if (!this.#attachment) return;
    if (this.#attachment.bounceTimer) {
      clearTimeout(this.#attachment.bounceTimer);
      this.#attachment.bounceTimer = null;
    }
    this.#attachment.stopStream();
    // Unwinds whatever holding the surface cost — a forwarded stream for an
    // owner elsewhere, nothing at all for one the provider drives directly.
    this.#attachment.handle.release();
    this.#attachment = null;
  }
}

/**
 * Environment-free remote-api v1 session; `docs/specs/remote-api.md` owns the
 * method, event, attachment, and size-authority contracts. All deployment work
 * is delegated to {@link HostSurfaceProvider}.
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
  type DirectoryEntry,
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
  /** Sends a remote-api response/event; the caller encrypts it onto the session. */
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
  #directoryGeneration = 0;
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

  /**
   * Answer one failed attach — and only when there is anyone to answer.
   *
   * Every failure on the attach path reads the same way: a disposed session has
   * no transport left, and a generation that moved on means a newer attach owns
   * the surface, which is what the client is told regardless of what actually
   * went wrong, because that is the fact it has to act on. `reason` is the rest,
   * for the paths where this attach is still the current one; omitted where
   * being superseded is the only way to get there. Failing rather than dropping
   * is load-bearing: the client holds the request pending, and its event
   * subscription with it.
   */
  #failAttach(
    request: RemoteRequest,
    surfaceId: string,
    generation: number,
    reason?: string,
  ): void {
    if (this.#disposed) return;
    this.#fail(
      request,
      reason !== undefined && this.#attachGeneration === generation
        ? reason
        : `superseded by a newer attach: ${surfaceId}`,
    );
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
    // Per collect, like the attach generation below and for the same reason:
    // two collects overlap whenever something changes during a slow round trip,
    // and they can settle in either order. Only the newest may emit, or a stale
    // one — including a collect that timed out to an empty answer — lands on
    // the client after a fresh snapshot and blanks its picker until the next
    // change.
    const generation = ++this.#directoryGeneration;
    // One snapshot per collect: the provider answers for every surface the Host
    // can reach, so no subset is known sooner than the rest.
    let entries: DirectoryEntry[];
    try {
      entries = await this.#provider.collectDirectory();
    } catch (error) {
      // This provider crosses a process/window boundary. A failed collection
      // leaves the last good snapshot standing and a later invalidation (or
      // re-watch) retries; it must not become an unhandled rejection that can
      // take down the Node Host process.
      if (
        this.#directorySubId === subId &&
        this.#directoryGeneration === generation &&
        !this.#disposed
      ) {
        console.warn('remote-host: directory collection failed', error);
      }
      return;
    }
    // The subscription may have been replaced or torn down while we waited.
    if (this.#directorySubId !== subId || this.#directoryGeneration !== generation) return;
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
    void this.#provider.resolveSurface(params.surfaceId, params).then(
      (handle) => {
        if (this.#disposed || this.#attachGeneration !== generation) {
          // A foreign resolve starts its stream before returning the handle. If
          // the session died or a newer attach superseded this one during that
          // round trip, unwind it immediately.
          handle?.release();
          this.#failAttach(request, params.surfaceId, generation);
          return;
        }
        if (!handle) {
          this.#fail(request, `no such surface: ${params.surfaceId}`);
          return;
        }
        try {
          this.#beginAttach(request, params, handle, generation);
        } catch (error) {
          // `streamPty` / the repaint bounce are provider calls too, and may
          // throw before an attachment is fully installed.
          if (this.#attachment?.handle === handle) this.#teardownAttachment();
          else handle.release();
          this.#failAttach(
            request,
            params.surfaceId,
            generation,
            `surface attach failed: ${errorMessage(error)}`,
          );
        }
      },
      (error) => {
        this.#failAttach(
          request,
          params.surfaceId,
          generation,
          `surface attach failed: ${errorMessage(error)}`,
        );
      },
    );
  }

  #beginAttach(
    request: RemoteRequest,
    params: AttachParams,
    handle: SurfaceHandle,
    generation: number,
  ): void {
    // v1: one attachment per session — replace any prior stream.
    this.#teardownAttachment();

    const ptyId = handle.ptyId;
    const cols = clampTerminalDimension(params.cols, handle.cols);
    const rows = clampTerminalDimension(params.rows, handle.rows);
    const sameSize = handle.cols === cols && handle.rows === rows;
    const subId = request.requestId;
    const pendingEvents: Array<{ event: string; data: unknown }> = [];
    let streaming = false;
    // A production provider replays an exit that happened before this
    // subscription was installed (the surface resolve is a process/window round
    // trip). Local replay is synchronous, so keep that callback safe before
    // `attachment` exists and fail rather than installing a dead PTY. Peer
    // replay is ordered before `stream.ready` and follows the installed path.
    let attachment: Attachment | null = null;
    let closedWhileSubscribing = false;
    const emitOrBuffer = (event: string, data: unknown): void => {
      if (streaming) {
        this.#event(subId, event, data);
      } else {
        pendingEvents.push({ event, data });
      }
    };
    const stream = this.#provider.streamPty(ptyId, {
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
        // instead of touching the now-dead PTY / disposed xterm.
        // Teardown unsubscribes this stream mid-callback, which is safe — the
        // subscription is this attachment's alone, so nothing is left to fire —
        // and nulls #attachment so #requireAttached fails and the bounce timer
        // is cleared.
        emitOrBuffer(REMOTE_EVENTS.terminalClosed, { exitCode });
        if (attachment && this.#attachment === attachment) {
          this.#teardownAttachment();
        } else {
          closedWhileSubscribing = true;
        }
      },
    });
    if (closedWhileSubscribing) {
      stream.stop();
      handle.release();
      this.#failAttach(
        request,
        params.surfaceId,
        generation,
        `surface closed while attaching: ${params.surfaceId}`,
      );
      return;
    }
    attachment = {
      surfaceId: params.surfaceId,
      handle,
      subId,
      stopStream: stream.stop,
      bounceTimer: null,
    };
    this.#attachment = attachment;
    const installedAttachment = attachment;

    // Attach-is-the-resize: resizing the real xterm fires its onResize handler,
    // which drives resizePty → SIGWINCH → the TUI/shell repaints, and that
    // repaint is what fills the client's screen (no snapshot transfer). The
    // stream is subscribed first because some PTYs repaint synchronously. For a
    // sibling window, `ready` waits for the owner's subscription acknowledgement
    // so an exit replay sent before that acknowledgement wins the race here.
    // A sibling's owner already applied the size inside the resolve round trip,
    // so its handle resolves at the requested size and takes the bounce below.
    const finish = (size: { cols: number; rows: number }): void => {
      if (this.#disposed) return;
      if (this.#attachGeneration !== generation || this.#attachment !== installedAttachment) {
        if (this.#attachment === installedAttachment) this.#teardownAttachment();
        this.#failAttach(
          request,
          params.surfaceId,
          generation,
          `surface closed while attaching: ${params.surfaceId}`,
        );
        return;
      }
      const result: TerminalAttachResult = { cols: size.cols, rows: size.rows };
      this.#ok(request, result);
      streaming = true;
      for (const event of pendingEvents) {
        this.#event(subId, event.event, event.data);
      }
    };

    const beginResize = (): void => {
      if (this.#disposed) return;
      if (this.#attachGeneration !== generation || this.#attachment !== installedAttachment) {
        if (this.#attachment === installedAttachment) this.#teardownAttachment();
        this.#failAttach(
          request,
          params.surfaceId,
          generation,
          `surface closed while attaching: ${params.surfaceId}`,
        );
        return;
      }

      if (!sameSize) {
        // The result promises the size the PTY now has, so do not acknowledge
        // the attach until the owner has actually applied it. Rejection is a
        // normal protocol error, not an unhandled Host-process rejection.
        void handle.resize(cols, rows).then(finish, (error) => {
          if (this.#attachment === installedAttachment) this.#teardownAttachment();
          this.#failAttach(
            request,
            params.surfaceId,
            generation,
            `surface attach failed: ${errorMessage(error)}`,
          );
        });
        return;
      }

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
      installedAttachment.bounceTimer = setTimeout(() => {
        installedAttachment.bounceTimer = null;
        if (this.#attachment !== installedAttachment) return;
        this.#provider.resizePty(ptyId, cols, rows);
      }, FORCE_REPAINT_BOUNCE_MS);
      finish({ cols: handle.cols, rows: handle.rows });
    };

    void stream.ready.then(beginResize, (error) => {
      if (this.#disposed) return;
      const closed = this.#attachment !== installedAttachment;
      if (this.#attachment === installedAttachment) this.#teardownAttachment();
      this.#failAttach(
        request,
        params.surfaceId,
        generation,
        closed
          ? `surface closed while attaching: ${params.surfaceId}`
          : `surface attach failed: ${errorMessage(error)}`,
      );
    });
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

    void handle.resize(cols, rows).then(
      (size) => {
        if (this.#disposed) return;
        if (this.#attachment !== attachment) {
          this.#fail(request, `surface is no longer attached: ${params.surfaceId}`);
          return;
        }
        this.#ok(request, { cols: size.cols, rows: size.rows } satisfies TerminalAttachResult);
      },
      (error) => {
        if (this.#disposed) return;
        this.#fail(request, `terminal resize failed: ${errorMessage(error)}`);
      },
    );
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'internal error';
}

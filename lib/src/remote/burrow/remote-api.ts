/**
 * Environment-free remote-api v1 session; `docs/specs/remote-api.md` owns the
 * method, event, attachment, and size-authority contracts. All deployment work
 * is delegated to {@link BurrowSurfaceProvider}.
 */

import {
  MAX_DEVICE_FIELD_LENGTH,
  REMOTE_EVENTS,
  REMOTE_METHODS,
  clampTerminalDimension,
  isBoundedString,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type AttachParams,
  type DeviceRefusalCode,
  type DevicePresenceRequired,
  type DevicesListResult,
  type DevicesRevokeResult,
  type PairedBrowserV1,
  type SurfaceCloseParams,
  type DirectoryEntry,
  type HelloParams,
  type HelloResult,
  type RemoteEventMsg,
  type RemoteRequest,
  type RemoteResponse,
  type TerminalAttachResult,
  type TerminalDataEvent,
  type TerminalResizeParams,
  type TerminalWriteParams,
} from 'remote-lib-common';
import { inputIsReplayTerminalReport } from '../../lib/terminal-report-filter';
import type { BurrowFrameHost } from './burrow-frame-host';
import type { BurrowSurfaceProvider, SurfaceHandle, SurfaceHold } from './burrow-surface-provider';
import type { SessionPresence } from './established-session';
import { clientErrorMessage } from '../../lib/errors';
import { FrameTunnel, MAX_SURFACE_ID_LENGTH } from './frame-tunnel';

/** Coalesce window for directory re-snapshots (remote-api.md: "Burrow coalesces"). */
const DIRECTORY_DEBOUNCE_MS = 150;

interface Attachment {
  surfaceId: string;
  /**
   * The resolved surface. Pinned at attach — a pane swap must not move the
   * attachment onto a different terminal — and it is the only thing here that
   * knows where the pane actually lives (`burrow-surface-provider.ts`).
   */
  handle: SurfaceHandle;
  subId: string;
  /** Unsubscribes this attachment's PTY stream; nobody else holds it. */
  stopStream: () => void;
}

export interface RemoteApiSessionOptions {
  burrowId: string;
  /** Sends a remote-api response/event; the caller encrypts it onto the session. */
  send: (payload: RemoteResponse | RemoteEventMsg) => void;
  /** Everything below the protocol: where surfaces live, and how PTYs are driven. */
  provider: BurrowSurfaceProvider;
  /**
   * Who this session is to the panes it sizes (`docs/specs/remote-api.md` →
   * "Size authority"): an id unique to it, opaque to every owner, the label a
   * held pane's strip shows, and the service instance that serves it.
   */
  holder: SessionHolder;
  /**
   * Where the frame tunnel reaches pages; absent, the Burrow serves no frames
   * and lists no embedded page (`docs/specs/remote-api.md` → "Frames").
   * `isDirect` says whether this session may open one.
   */
  frames?: { host: BurrowFrameHost; isDirect: () => boolean };
  /**
   * The Burrow's paired browsers, for a paired session alone
   * (`docs/specs/remote-api.md` -> "Paired browsers"); absent, `devices.*` is
   * the unknown method it is on an older Burrow.
   */
  devices?: SessionDevices;
  /** Called once, when this session is disposed. */
  onDispose?: () => void;
  /** An attach succeeded: the access log's `attached` (`access-log.ts`). Never told what the surface shows. */
  onAttach?: (surfaceId: string) => void;
  /** A close succeeded: the access log's `closed`. */
  onClose?: (surfaceId: string) => void;
}

/** A device id's reading on this Burrow: one paired browser, or the refusal. */
export type DeviceResolution = { readonly self: boolean } | 'unknown-device' | 'ambiguous-device';

/** {@link RemoteApiSessionOptions.devices}: what no session can reach but through a proof it shows here. */
export interface SessionDevices {
  readonly presence: SessionPresence;
  list(): Promise<PairedBrowserV1[]>;
  resolve(id: string): Promise<DeviceResolution>;
  /** Revoke the one paired browser `id` names, under this session's requester. */
  revoke(id: string): Promise<'revoked' | 'unknown-device' | 'ambiguous-device'>;
}

/** The list's own name for what a challenge was issued for; a revoke's is its id. */
const LIST_REQUEST = Symbol('devices.list');

/** {@link RemoteApiSessionOptions.holder}. */
export interface SessionHolder {
  readonly id: string;
  readonly label: string;
  /** {@link SurfaceHold.serviceId}. */
  readonly serviceId: string;
}

export class RemoteApiSession {
  readonly #burrowId: string;
  readonly #send: (payload: RemoteResponse | RemoteEventMsg) => void;
  readonly #provider: BurrowSurfaceProvider;
  readonly #holder: SessionHolder;
  readonly #onDispose: (() => void) | null;
  readonly #onAttach: ((surfaceId: string) => void) | null;
  readonly #onClose: ((surfaceId: string) => void) | null;
  readonly #devices: SessionDevices | null;
  /** Which request the session's one live challenge answers: the Burrow's memory of what a proof is for. */
  #challengedFor: string | typeof LIST_REQUEST | null = null;
  /** This session has shown a proof, at its connection or since; a window ride shows none. */
  #presenceShown: boolean;

  #directorySubId: string | null = null;
  #unsubDirectory: (() => void) | null = null;
  #directoryTimer: ReturnType<typeof setTimeout> | null = null;
  #directoryGeneration = 0;
  #attachment: Attachment | null = null;
  #attachGeneration = 0;
  readonly #frames: FrameTunnel | null;
  readonly #frameHost: BurrowFrameHost | null;
  /** The Client's hello declared it frames pages, so the directory lists them. */
  #listsFrames = false;
  #disposed = false;

  constructor(options: RemoteApiSessionOptions) {
    this.#burrowId = options.burrowId;
    this.#send = options.send;
    this.#provider = options.provider;
    this.#holder = options.holder;
    this.#onDispose = options.onDispose ?? null;
    this.#onAttach = options.onAttach ?? null;
    this.#onClose = options.onClose ?? null;
    this.#devices = options.devices ?? null;
    this.#presenceShown = options.devices?.presence.provedAtConnection ?? false;
    this.#frameHost = options.frames?.host ?? null;
    this.#frames = options.frames
      ? new FrameTunnel({
        host: options.frames.host,
        isDirect: options.frames.isDirect,
        provider: options.provider,
        // The session's, never a webview's: disposal ends every grant it holds.
        leaseOwner: options.holder.id,
        ok: (request, result) => this.#ok(request, result),
        fail: (request, error) => this.#fail(request, error),
        event: (subId, event, data) => this.#event(subId, event, data),
      })
      : null;
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
        case REMOTE_METHODS.surfaceClose:
          return this.#surfaceClose(request);
        case REMOTE_METHODS.surfaceAttach:
          return this.#attach(request);
        case REMOTE_METHODS.surfaceDetach:
          return this.#detach(request);
        case REMOTE_METHODS.terminalWrite:
          return this.#write(request);
        case REMOTE_METHODS.terminalResize:
          return this.#resize(request);
        case REMOTE_METHODS.devicesList:
          if (this.#devices) return this.#answerDevices(request, this.#devicesList(request, this.#devices));
          return this.#fail(request, `unknown method: ${request.method}`);
        case REMOTE_METHODS.devicesRevoke:
          if (this.#devices) return this.#answerDevices(request, this.#devicesRevoke(request, this.#devices));
          return this.#fail(request, `unknown method: ${request.method}`);
        default:
          if (this.#frames && FrameTunnel.owns(request.method)) return this.#frames.handle(request);
          return this.#fail(request, `unknown method: ${request.method}`);
      }
    } catch (error) {
      this.#fail(request, clientErrorMessage(error));
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
    this.#frames?.dispose();
    this.#onDispose?.();
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
      burrowId: this.#burrowId,
      grants: { input: true, layout: false },
      ...(this.#frames ? { frames: true } : {}),
      ...(this.#devices ? { devices: true } : {}),
    };
    const capabilities = (request.params as Partial<HelloParams> | undefined)?.capabilities;
    const listsFrames = !!this.#frames && capabilities?.frames === true;
    const changed = listsFrames !== this.#listsFrames;
    this.#listsFrames = listsFrames;
    this.#ok(request, result);
    // A hello after the watch changes what the listing may name.
    if (changed) void this.#emitDirectory();
  }

  /** Only a Client that frames pages has a Tool or page of its own to close. */
  #surfaceClose(request: RemoteRequest): void {
    const { surfaceId, confirmed, unsaved } = (request.params ?? {}) as Partial<SurfaceCloseParams>;
    if (!this.#listsFrames) return this.#fail(request, 'this session closes nothing');
    if (!surfaceId || !isBoundedString(surfaceId, MAX_SURFACE_ID_LENGTH)) {
      return this.#fail(request, 'invalid surface.close: surfaceId');
    }
    if ((confirmed !== undefined && typeof confirmed !== 'boolean') || (unsaved !== undefined && unsaved !== 'save' && unsaved !== 'discard')) {
      return this.#fail(request, 'invalid surface.close: consent');
    }
    void this.#provider.closeSurface(surfaceId, { confirmed, unsaved }).then((result) => {
      // Logged though the Client went while it was saving: the Tool closed.
      if (result.outcome === 'closed') this.#onClose?.(surfaceId);
      if (!this.#disposed) this.#ok(request, result);
    });
  }

  /**
   * The Burrow's paired browsers, to a session that has shown a proof: its
   * connection's or one over the challenge a bare request is answered with. A
   * window ride has shown none (`docs/specs/remote-api.md` -> "Paired browsers").
   */
  async #devicesList(request: RemoteRequest, devices: SessionDevices): Promise<DevicesListResult> {
    const { proof } = (request.params ?? {}) as { proof?: unknown };
    if (proof !== undefined) {
      if (!(await this.#proves(devices, proof, LIST_REQUEST))) return refused('presence-rejected');
    } else if (!this.#presenceShown) {
      return this.#challenge(devices, LIST_REQUEST);
    }
    return { outcome: 'devices', devices: await devices.list() };
  }

  /**
   * Revoke one paired browser by its id, on a proof over a challenge this very
   * request was answered with: **never on a window ride or a proof shown
   * earlier** (`docs/specs/remote-security-model.md` -> "Revocation").
   *
   * A session revoking itself is answered first, since the revocation's goodbye
   * ends it and nothing after that is read.
   */
  async #devicesRevoke(request: RemoteRequest, devices: SessionDevices): Promise<DevicesRevokeResult | null> {
    const { id, proof } = (request.params ?? {}) as { id?: unknown; proof?: unknown };
    if (!isBoundedString(id, MAX_DEVICE_FIELD_LENGTH)) return refused('unknown-device');
    const found = await devices.resolve(id);
    if (typeof found === 'string') return refused(found);
    if (proof === undefined) return this.#challenge(devices, id);
    if (!(await this.#proves(devices, proof, id))) return refused('presence-rejected');
    if (found.self) this.#ok(request, { outcome: 'revoked', self: true } satisfies DevicesRevokeResult);
    const result = await devices.revoke(id);
    if (found.self) return null;
    return result === 'revoked' ? { outcome: 'revoked', self: false } : refused(result);
  }

  #challenge(devices: SessionDevices, request: string | typeof LIST_REQUEST): DevicePresenceRequired {
    const challenge = devices.presence.issueChallenge();
    this.#challengedFor = request;
    return { outcome: 'presence-required', challenge };
  }

  /**
   * Whether `proof` is good and its challenge was issued for `request`. The
   * challenge is spent either way, so a proof for one request costs the session
   * its challenge when shown for another.
   */
  async #proves(devices: SessionDevices, proof: unknown, request: string | typeof LIST_REQUEST): Promise<boolean> {
    const challengedFor = this.#challengedFor;
    this.#challengedFor = null;
    const verified = await devices.presence.verifyProof(proof);
    if (this.#disposed || !verified || challengedFor !== request) return false;
    this.#presenceShown = true;
    return true;
  }

  /** Answer one `devices.*` request, whatever became of it; `null` was answered already. */
  #answerDevices(request: RemoteRequest, answer: Promise<DevicesListResult | DevicesRevokeResult | null>): void {
    void answer.catch((error: unknown) => {
      // A provider or a store past this process boundary. Never its text: the
      // Client words every refusal itself.
      console.warn('burrow: a devices request failed', error);
      return refused('burrow-error');
    }).then((result) => {
      if (result && !this.#disposed) this.#ok(request, result);
    });
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
    // One snapshot per collect: the provider answers for every surface the Burrow
    // can reach, so no subset is known sooner than the rest.
    let entries: DirectoryEntry[];
    try {
      entries = await this.#provider.collectDirectory();
    } catch (error) {
      // This provider crosses a process/window boundary. A failed collection
      // leaves the last good snapshot standing and a later invalidation (or
      // re-watch) retries; it must not become an unhandled rejection that can
      // take down the Node Burrow process.
      if (
        this.#directorySubId === subId &&
        this.#directoryGeneration === generation &&
        !this.#disposed
      ) {
        console.warn('burrow: directory collection failed', error);
      }
      return;
    }
    // The subscription may have been replaced or torn down while we waited.
    if (this.#directorySubId !== subId || this.#directoryGeneration !== generation) return;
    // Awaited here rather than beside the collect, since it needs only the pages
    // the Burrow will list; the generation is read again after it.
    const listed = this.#listsFrames ? await this.#openablePages(entries) : terminalsOnly(entries);
    if (this.#disposed || this.#directorySubId !== subId || this.#directoryGeneration !== generation) return;
    this.#event(subId, REMOTE_EVENTS.directorySnapshot, { entries: listed });
  }

  /** `entries` less any page the frame tunnel would refuse. */
  async #openablePages(entries: DirectoryEntry[]): Promise<DirectoryEntry[]> {
    const host = this.#frameHost!;
    const verdicts = await Promise.all(entries.map((entry) => (entry.browser ? host.canOpen(entry.browser.url) : true)));
    return terminalsOnly(entries, (_, index) => verdicts[index]!);
  }

  #attach(request: RemoteRequest): void {
    const params = request.params as AttachParams | undefined;
    if (typeof params?.surfaceId !== 'string' || !params.surfaceId) {
      this.#fail(request, `no such surface: ${params?.surfaceId ?? '(none)'}`);
      return;
    }

    // Where the pane lives — a registry here or an owner a round trip away — is
    // a deployment fact, not a protocol concept, so it is settled below this
    // line and never seen here (`burrow-surface-provider.ts`).
    //
    // Per attach, not per session: last-attach-wins has to hold while a
    // resolve is in flight, and the two paths are wildly different lengths — a
    // sibling's pane is a round trip away while a local one settles on the next
    // microtask, so one shared epoch would let the older, slower attach land
    // last and take the attachment.
    const generation = ++this.#attachGeneration;
    // Per attach too: a release names the attachment it gives up, so one from
    // an attachment this session has since replaced — the same pane included —
    // cannot free the hold its successor took.
    const { id, label, serviceId } = this.#holder;
    const hold: SurfaceHold = { holder: id, label, lease: String(generation), serviceId };
    void this.#provider.resolveSurface(params.surfaceId, params, hold).then(
      (handle) => {
        if (!handle) {
          // Nobody owns it — or its owner answered past the budget, having
          // taken the hold all the same.
          this.#releaseUnresolved(params.surfaceId, hold);
          this.#failAttach(
            request,
            params.surfaceId,
            generation,
            `no such surface: ${params.surfaceId}`,
          );
          return;
        }
        if (this.#disposed || this.#attachGeneration !== generation) {
          // The owner took the hold inside the resolve; nothing will attach it.
          this.#release(handle);
          this.#failAttach(request, params.surfaceId, generation);
          return;
        }
        try {
          this.#beginAttach(request, params, handle, generation);
        } catch (error) {
          // `streamPty` / the repaint bounce are provider calls too, and may
          // throw before an attachment is fully installed.
          if (this.#attachment?.handle === handle) this.#teardownAttachment();
          else this.#release(handle);
          this.#failAttach(
            request,
            params.surfaceId,
            generation,
            `surface attach failed: ${clientErrorMessage(error)}`,
          );
          return;
        }
        this.#onAttach?.(params.surfaceId);
      },
      (error) => {
        // No handle to release through, and the owner may hold the pane anyway.
        this.#releaseUnresolved(params.surfaceId, hold);
        this.#failAttach(
          request,
          params.surfaceId,
          generation,
          `surface attach failed: ${clientErrorMessage(error)}`,
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
      onData: (chunk) => {
        // Both projections cross, so the Client's text consumers see what the
        // owner's do. `text` is omitted whenever the two are identical, which
        // is every chunk carrying no string control.
        const event: TerminalDataEvent = { bytes: toBase64Url(utf8Encode(chunk.data)) };
        if (chunk.textData !== undefined) event.text = toBase64Url(utf8Encode(chunk.textData));
        emitOrBuffer(REMOTE_EVENTS.terminalData, event);
      },
      onExit: (exitCode) => {
        // Deliver the close to the client first, then drop the attachment so a
        // later write/resize for this surface fails safe with "not attached"
        // instead of touching the now-dead PTY / disposed xterm.
        // Teardown unsubscribes this stream mid-callback, which is safe — the
        // subscription is this attachment's alone, so nothing is left to fire —
        // and nulls #attachment so #requireAttached fails.
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
      this.#release(handle);
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
        // normal protocol error, not an unhandled Burrow-process rejection.
        void handle.resize(cols, rows).then(finish, (error) => {
          if (this.#attachment === installedAttachment) this.#teardownAttachment();
          this.#failAttach(
            request,
            params.surfaceId,
            generation,
            `surface attach failed: ${clientErrorMessage(error)}`,
          );
        });
        return;
      }

      // The PTY owner sees every local/remote resize, so only it can restore
      // a same-size repaint without overwriting a later size writer.
      this.#provider.resizePty(ptyId, cols, rows, true);
      finish({ cols: handle.cols, rows: handle.rows });
    };

    // Catch failures from readiness *and* from starting the resize: providers
    // may throw synchronously even though readiness itself fulfilled.
    void stream.ready.then(beginResize).catch((error) => {
      if (this.#disposed) return;
      const closed = this.#attachment !== installedAttachment;
      if (this.#attachment === installedAttachment) this.#teardownAttachment();
      this.#failAttach(
        request,
        params.surfaceId,
        generation,
        closed
          ? `surface closed while attaching: ${params.surfaceId}`
          : `surface attach failed: ${clientErrorMessage(error)}`,
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
    const text = utf8Decode(fromBase64Url(params.bytes));
    // A mirror's xterm answers the queries its own renderer sees; the owner has
    // already answered them (remote-api.md -> "Terminal surfaces"). Dropped
    // rather than refused: the write is well-formed, and the client is not
    // owed an error for bytes it never chose to send.
    if (inputIsReplayTerminalReport(text)) {
      this.#ok(request, {});
      return;
    }
    // Feed the existing PTY input path; the local echo returns via the stream.
    this.#provider.writePty(attachment.handle.ptyId, text);
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
        this.#fail(request, `terminal resize failed: ${clientErrorMessage(error)}`);
      },
    );
  }

  /**
   * Stop streaming the attachment and give its pane's size back — every way an
   * attachment ends: detach, a newer attach, exit, a failed attach, disposal.
   */
  #teardownAttachment(): void {
    const attachment = this.#attachment;
    if (!attachment) return;
    attachment.stopStream();
    this.#attachment = null;
    this.#release(attachment.handle);
  }

  /**
   * Give up the hold `handle` was resolved with. The owner clears it only while
   * that very hold is still its holder's, so releasing is always safe; a
   * provider that throws must not take a teardown down with it.
   */
  #release(handle: SurfaceHandle): void {
    try {
      handle.release();
    } catch (error) {
      console.warn('burrow: releasing a surface failed', error);
    }
  }

  /**
   * Give up `hold` on a surface no handle was resolved for, at every owner
   * that could have taken it — as safe as {@link #release}, and for the same
   * reason.
   */
  #releaseUnresolved(surfaceId: string, hold: SurfaceHold): void {
    try {
      this.#provider.releaseSurface(surfaceId, hold);
    } catch (error) {
      console.warn('burrow: releasing a surface failed', error);
    }
  }
}

function refused(code: DeviceRefusalCode): { outcome: 'refused'; code: DeviceRefusalCode } {
  return { outcome: 'refused', code };
}

/**
 * The listing with only the pages `keepsPage` keeps: a browser entry whose page
 * goes is gone, and a terminal entry stays without it. With none kept, it is
 * what a Client that frames nothing reads, so it never offers what it cannot show.
 */
function terminalsOnly(
  entries: DirectoryEntry[],
  keepsPage: (entry: DirectoryEntry, index: number) => boolean = () => false,
): DirectoryEntry[] {
  return entries.flatMap((entry, index) => {
    if (entry.browser === undefined || keepsPage(entry, index)) return [entry];
    if (entry.type !== 'terminal') return [];
    const { browser: _browser, ...rest } = entry;
    return [rest];
  });
}

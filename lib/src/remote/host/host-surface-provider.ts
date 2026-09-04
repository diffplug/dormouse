/**
 * Environment-free seam between protocol-v1 and surface ownership; see
 * `docs/specs/remote-api.md` → "The provider seam". Types only.
 */

import type { DirectoryEntry } from 'server-lib-common';

// Re-exported so an implementor can name the entry type without depending on
// `server-lib-common` itself; vscode-ext's project does not resolve it.
export type { DirectoryEntry };

export interface SurfaceHandle {
  /**
   * Provider-local routing key; a peer-backed handle need not expose its
   * owner's raw PTY id.
   */
  readonly ptyId: string;
  /** The size the surface stands at now — live for a local pane, last-reported for a peer's. */
  readonly cols: number;
  readonly rows: number;
  /** Resize through the owner's live xterm, and report what it settled at. */
  resize(cols: number, rows: number): Promise<{ cols: number; rows: number }>;
  /** Let go: stops a peer's stream, nothing to undo for a local pane. */
  release(): void;
}

// The chunk a sink receives is the one the PTY owner's parser produced, so the
// projection pair is defined beside that parse rather than restated here.
export type { ProcessedPtyChunk } from '../../lib/processed-pty-stream';
import type { ProcessedPtyChunk } from '../../lib/processed-pty-stream';

/**
 * One attachment's view of a PTY. Exit carries no id: a sink is subscribed to
 * exactly one PTY, so there is nothing to filter and no way to mistake another
 * PTY's death for this one's.
 */
export interface PtySink {
  onData(chunk: ProcessedPtyChunk): void;
  onExit(exitCode: number): void;
}

export interface PtyStream {
  /** Stop this sink's stream. Idempotent after exit. */
  stop(): void;
  /**
   * Settles only after the sink is installed at the PTY owner. For an in-process
   * owner this is already resolved; a cross-window provider waits for the peer's
   * subscription acknowledgement.
   */
  readonly ready: Promise<void>;
}

export interface HostSurfaceProvider {
  /**
   * Every surface the Host can reach right now, from wherever they live —
   * peers included, so the session emits one snapshot per collect rather than
   * knowing that some entries arrive later than others.
   */
  collectDirectory(): Promise<DirectoryEntry[]>;

  /**
   * Fire `onChange` whenever a future {@link collectDirectory} could differ —
   * pane state, activity, focus, peer membership. Returns the unsubscribe. The
   * session coalesces, so firing too often is cheap and missing a change is not.
   */
  watchDirectory(onChange: () => void): () => void;

  /**
   * Take hold of `surfaceId` at the size the client asked for, or `null` if
   * nobody owns it.
   *
   * The size is part of resolving because attach-is-the-resize
   * (docs/specs/remote-api.md): an owner that is a round trip away has to apply
   * it inside the attach, since there is no way to reach into its xterm
   * afterwards without a second one. An owner the provider can touch directly
   * is left alone here and resized by the caller, which subscribes to the PTY
   * first so a synchronous repaint is not lost — the resolved handle reports
   * the size as it stands, and the caller reconciles.
   */
  resolveSurface(
    surfaceId: string,
    size: { cols?: number; rows?: number },
  ): Promise<SurfaceHandle | null>;

  /** Feed the PTY's input path; the local echo returns through {@link streamPty}. */
  writePty(ptyId: string, data: string): void;

  /**
   * Resize the PTY *only*, leaving any owning xterm alone. This is the
   * same-size repaint bounce's path, not the attach path — attach-is-the-resize
   * goes through {@link SurfaceHandle.resize} so the owner's own view follows.
   */
  resizePty(ptyId: string, cols: number, rows: number): void;

  /**
   * Subscribe to one PTY's output and exit. Subscription and liveness observation
   * are atomic at the owner: if this PTY already exited, call `sink.onExit`
   * before `ready` settles. In-process providers replay synchronously; a
   * cross-window provider waits for the owner's acknowledgement, ordered after
   * any replay on the same socket. That closes the asynchronous
   * `resolveSurface` -> subscription gap without making the protocol session
   * know how either Host records PTY lifetime.
   *
   * Per-PTY rather than a global stream the caller filters, so an attachment
   * cannot leak another attachment's bytes and unsubscribing cannot outlive its
   * id.
   */
  streamPty(ptyId: string, sink: PtySink): PtyStream;
}

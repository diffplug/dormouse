/**
 * {@link PlatformAdapter} over remote-api v1; `docs/specs/pocket-app.md` owns
 * the mapping. Registry events are keyed by `surfaceId`, and each active-pane
 * change must call {@link setActivePane} because v1 streams one attachment.
 */

import {
  clampTerminalDimension,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type DirectoryEntry,
  type TerminalAttachResult,
  type TerminalDataEvent,
} from 'remote-lib-common';
import type { AwaitHandle, AwaitOutcome } from '../../lib/alert-manager';
import type { PlatformAdapter, PtyDataDetail, PtyInfo, OpenPort } from '../../lib/platform/types';
import { inputIsReplayTerminalReport } from '../../lib/terminal-report-filter';

/** Terminal stream callbacks for {@link RemoteAdapterClient.attach}. */
export interface TerminalHandlers {
  /** One `terminal.data` payload: the renderer projection, and the text one
   *  when it differs. Passed whole rather than as bytes so the pair cannot be
   *  split here (`docs/specs/remote-api.md` → "Terminal surfaces"). */
  onData(event: TerminalDataEvent): void;
  onClosed?(exitCode?: number): void;
}

/**
 * The slice of an established session the adapter drives. `ClientSessionCore`
 * implements it, a connected `PocketClient` satisfies it structurally, and
 * tests pass a network-free fake.
 */
export interface RemoteAdapterClient {
  watchDirectory(onSnapshot: (entries: DirectoryEntry[]) => void): Promise<string>;
  attach(
    surfaceId: string,
    cols: number,
    rows: number,
    handlers: TerminalHandlers,
  ): Promise<{ subId: string; result: TerminalAttachResult }>;
  write(surfaceId: string, bytes: string): Promise<unknown>;
  resize(surfaceId: string, cols: number, rows: number): Promise<unknown>;
  detach(surfaceId: string, subId?: string): Promise<unknown>;
  unsubscribe(subId: string): void;
}

interface Attachment {
  surfaceId: string;
  subId: string;
}

interface Size {
  cols: number;
  rows: number;
}

/** A `setActivePane` whose attach has not landed, and the latest size asked of it since. */
interface PendingAttach {
  surfaceId: string;
  generation: number;
  size: Size;
}

const DEFAULT_SIZE: Size = { cols: 80, rows: 24 };

type DataHandler = (detail: PtyDataDetail) => void;
type ExitHandler = (detail: { id: string; exitCode: number }) => void;
type ListHandler = (detail: { ptys: PtyInfo[] }) => void;
type DirectoryListener = (entries: DirectoryEntry[]) => void;

export class RemotePtyAdapter implements PlatformAdapter {
  readonly #client: RemoteAdapterClient;

  readonly #dataHandlers = new Set<DataHandler>();
  readonly #exitHandlers = new Set<ExitHandler>();
  readonly #listHandlers = new Set<ListHandler>();
  readonly #directoryListeners = new Set<DirectoryListener>();

  /** Latest directory snapshot, in Burrow order. */
  #entries: DirectoryEntry[] = [];

  /** Memoized directory.watch start; also the "started" guard. */
  #watchPromise: Promise<void> | null = null;
  #directorySubId: string | null = null;
  #disposed = false;

  /** The one attached surface (v1: one attachment per session), or null. */
  #attached: Attachment | null = null;
  /** Bumped on every setActivePane so a superseded async attach can bail. */
  #activeGeneration = 0;
  // A stale detach is keyed by surfaceId on the wire: finish it before another
  // attachment to that same surface can start (rapid A → B → A switching).
  #attachQueue: Promise<void> = Promise.resolve();
  /** Last size seen, so a re-attach can reuse it if the caller omits one. */
  #lastSize: Size = DEFAULT_SIZE;
  /** The latest {@link setActivePane}'s attach until it lands or is superseded. */
  #pending: PendingAttach | null = null;

  #savedState: unknown = null;

  constructor(client: RemoteAdapterClient) {
    this.#client = client;
  }

  // --- Lifecycle -----------------------------------------------------------

  async init(): Promise<void> {
    await this.#ensureDirectoryWatch();
  }

  shutdown(): void {
    void this.dispose();
  }

  /** Detach the live surface and stop watching the directory. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const attached = this.#attached;
    this.#attached = null;
    this.#pending = null;
    this.#activeGeneration++;
    if (this.#directorySubId) {
      this.#client.unsubscribe(this.#directorySubId);
      this.#directorySubId = null;
    }
    this.#directoryListeners.clear();
    if (attached) {
      try {
        await this.#client.detach(attached.surfaceId, attached.subId);
      } catch {
        // best effort — the socket may already be gone
      }
    }
  }

  // --- Directory (onPtyList + adapter-specific getters) --------------------

  requestInit(): void {
    if (this.#disposed) return;
    void this.#ensureDirectoryWatch().catch(() => {});
    // Give a resuming UI the latest known list immediately.
    if (this.#entries.length > 0) this.#emitPtyList();
  }

  onPtyList(handler: ListHandler): void {
    this.#listHandlers.add(handler);
  }

  offPtyList(handler: ListHandler): void {
    this.#listHandlers.delete(handler);
  }

  /** The full directory snapshot (titles/activity/ringing/hasTODO) without attaching. */
  getDirectoryEntries(): DirectoryEntry[] {
    return [...this.#entries];
  }

  /** The directory entry for a surface, or undefined. */
  getPaneEntry(surfaceId: string): DirectoryEntry | undefined {
    return this.#entries.find((entry) => entry.surfaceId === surfaceId);
  }

  /** Subscribe to directory snapshots; returns an unsubscribe fn. */
  subscribeDirectory(listener: DirectoryListener): () => void {
    this.#directoryListeners.add(listener);
    return () => {
      this.#directoryListeners.delete(listener);
    };
  }

  #ensureDirectoryWatch(): Promise<void> {
    if (this.#disposed) return Promise.resolve();
    if (!this.#watchPromise) {
      this.#watchPromise = this.#client
        .watchDirectory((entries) => this.#onSnapshot(entries))
        .then((subId) => {
          if (this.#disposed) this.#client.unsubscribe(subId);
          else this.#directorySubId = subId;
        })
        .catch((error: unknown) => {
          this.#watchPromise = null;
          throw error;
        });
    }
    return this.#watchPromise;
  }

  #onSnapshot(entries: DirectoryEntry[]): void {
    if (this.#disposed) return;
    this.#entries = entries;
    this.#emitPtyList();
    for (const listener of this.#directoryListeners) listener(entries);
  }

  #emitPtyList(): void {
    const ptys: PtyInfo[] = this.#entries.map((entry) => ({
      id: entry.surfaceId,
      // `entry.alive` is real PTY-process liveness (a lingering exited surface
      // reports false), NOT `entry.exitCode` — that is the last command's
      // shell-integration status, which deriving alive from was the bug.
      alive: entry.alive,
    }));
    for (const handler of this.#listHandlers) handler({ ptys });
  }

  // --- Attach / active pane (adapter-specific extra) -----------------------

  /**
   * Make `id` the single attached surface: detach the previous one, then
   * `surface.attach` with `cols`/`rows`. Its `terminal.data` becomes
   * `onPtyData`, `terminal.closed` becomes `onPtyExit`.
   */
  async setActivePane(id: string, cols?: number, rows?: number): Promise<void> {
    if (this.#disposed) return;
    const size = normalizeSize(cols, rows, this.#lastSize);
    this.#lastSize = size;
    const pending: PendingAttach = { surfaceId: id, generation: ++this.#activeGeneration, size };
    this.#pending = pending;
    const activation = this.#attachQueue.then(() => this.#activatePane(pending));
    this.#attachQueue = activation.catch(() => {});
    await activation;
  }

  async #activatePane(pending: PendingAttach): Promise<void> {
    const { surfaceId: id, generation } = pending;
    if (generation !== this.#activeGeneration) return;

    if (this.#attached?.surfaceId === id) {
      this.#settle(pending);
      // Already the active surface — a size change is just a resize.
      await this.#client.resize(id, pending.size.cols, pending.size.rows);
      return;
    }

    const prev = this.#attached;
    this.#attached = null;
    if (prev) {
      try {
        await this.#client.detach(prev.surfaceId, prev.subId);
      } catch {
        // best effort
      }
    }
    if (generation !== this.#activeGeneration) return; // superseded mid-detach

    let closed = false;
    const handlers: TerminalHandlers = {
      onData: (event) => { if (!closed) this.#emitData(id, event); },
      onClosed: (exitCode) => {
        closed = true;
        this.#emitExit(id, exitCode);
      },
    };
    // Read here rather than at `setActivePane`: a resize that landed while the
    // previous pane detached is carried by the attach itself.
    const size = pending.size;
    const { subId } = await this.#client.attach(id, size.cols, size.rows, handlers);
    if (closed || generation !== this.#activeGeneration) {
      this.#settle(pending);
      // Superseded or closed before its response: never resurrect this attach.
      this.#client.unsubscribe(subId);
      await this.#client.detach(id, subId).catch(() => {});
      return;
    }
    this.#attached = { surfaceId: id, subId };
    this.#settle(pending);
    // The wall fits a new pane's xterm while its attach is in flight, and the
    // attach carried the size from before the fit: without this the Burrow's
    // PTY stays there, and every line the phone shows wraps at the wrong width.
    // Best effort, as `resizePty` is: the attach landed, and a resize the Burrow
    // refuses — a terminal that exited just after it — must not end the session.
    const latest = pending.size;
    if (latest.cols !== size.cols || latest.rows !== size.rows) {
      await this.#client.resize(id, latest.cols, latest.rows).catch(() => {});
    }
  }

  /** Stop routing resizes to `pending`, unless a later `setActivePane` already has. */
  #settle(pending: PendingAttach): void {
    if (this.#pending === pending) this.#pending = null;
  }

  /** The currently attached surfaceId, or null. */
  get activeSurfaceId(): string | null {
    return this.#attached?.surfaceId ?? null;
  }

  // --- PTY core ------------------------------------------------------------

  writePty(id: string, data: string): void {
    if (this.#attached?.surfaceId !== id) return; // Burrow only accepts the attached pane
    // The Burrow discards these anyway (remote-api.md -> "Terminal surfaces"), so
    // don't spend the relay on them.
    if (inputIsReplayTerminalReport(data)) return;
    void this.#client.write(id, toBase64Url(utf8Encode(data))).catch(() => {});
  }

  resizePty(id: string, cols: number, rows: number): void {
    const attached = this.#attached?.surfaceId === id;
    const pending = this.#pending?.surfaceId === id ? this.#pending : null;
    // Burrow only accepts the attached pane, and the one being attached gets
    // this size from its activation.
    if (!attached && !pending) return;
    const size = normalizeSize(cols, rows, this.#lastSize);
    this.#lastSize = size;
    if (pending) pending.size = size;
    if (!attached) return;
    void this.#client.resize(id, size.cols, size.rows).catch(() => {});
  }

  // Panes are Burrow-owned: the phone never spawns or kills them.
  spawnPty(): void {}
  killPty(): void {}

  onPtyData(handler: DataHandler): void {
    this.#dataHandlers.add(handler);
  }

  offPtyData(handler: DataHandler): void {
    this.#dataHandlers.delete(handler);
  }

  onPtyExit(handler: ExitHandler): void {
    this.#exitHandlers.add(handler);
  }

  offPtyExit(handler: ExitHandler): void {
    this.#exitHandlers.delete(handler);
  }

  #emitData(id: string, event: TerminalDataEvent): void {
    if (this.#disposed) return;
    let data: string;
    let textData: string | undefined;
    try {
      data = utf8Decode(fromBase64Url(event.bytes));
      // Omitted means identical; an explicitly empty text projection stays empty.
      textData = event.text === undefined ? undefined : utf8Decode(fromBase64Url(event.text));
    } catch {
      // Both projections describe one chunk: never deliver only its valid half.
      console.warn('[pocket] discarding malformed terminal data');
      return;
    }
    for (const handler of this.#dataHandlers) handler({ id, data, textData });
  }

  #emitExit(id: string, exitCode?: number): void {
    if (this.#disposed) return;
    if (this.#attached?.surfaceId === id) this.#attached = null;
    // An absent exitCode is an UNKNOWN termination (signal-only, killed, or a
    // non-selfhost Burrow that never reports one) — not a clean exit. Coercing it
    // to 0 would paint an abnormal close as success. Map it to the same -1
    // sentinel the local path uses (terminal-lifecycle.ts `exitCode ?? -1`),
    // which renders as a nonzero "failure" exit, so remote and local agree.
    for (const handler of this.#exitHandlers) handler({ id, exitCode: exitCode ?? -1 });
  }

  // --- Degraded capabilities (absent PTY features) -------------------------

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    return [];
  }

  async getCwd(): Promise<string | null> {
    return null;
  }

  async getOpenPorts(): Promise<OpenPort[]> {
    return [];
  }

  async getOpenPortsMany(ids: string[]): Promise<Record<string, OpenPort[]>> {
    return Object.fromEntries(ids.map((id) => [id, []]));
  }

  async readClipboardFilePaths(): Promise<string[] | null> {
    return null;
  }

  async readClipboardImageAsFilePath(): Promise<string | null> {
    return null;
  }

  // Resume-path replay: the Burrow has no per-pane replay buffer in v1, so ignore.
  onPtyReplay(): void {}
  offPtyReplay(): void {}

  // Burrow-initiated persistence flush: not driven from the phone.
  onRequestSessionFlush(): void {}
  offRequestSessionFlush(): void {}
  notifySessionFlushComplete(): void {}

  // Alerts are Burrow-authoritative (surfaced via the directory snapshot), so the
  // phone-side alert controls are inert.
  alertSetWatchedCommands(): void {}
  alertSetCommandWatched(): void {}
  alertPublishSettings(): void {}
  alertDismiss(): void {}
  alertEngagement(): void {}
  alertPublishSessions(): void {}
  alertAcknowledge(): void {}
  alertToggleTodo(): void {}
  alertClearTodo(): void {}
  /**
   * There is no `dor` on the phone and protocol-v1 carries no await, so a
   * request here has nothing to park on: settle it `cancelled` rather than
   * hand back a promise that never resolves.
   */
  alertAwait(): AwaitHandle {
    return { promise: Promise.resolve<AwaitOutcome>({ kind: 'cancelled', waitedMs: 0 }), cancel: () => {} };
  }
  onAlertState(): void {}
  onWatchedCommands(): void {}
  onAlertSettings(): void {}
  onAlertSpeak(): () => void {
    return () => {};
  }

  saveState(state: unknown): void {
    this.#savedState = state;
  }

  getState(): unknown {
    return this.#savedState;
  }
}

/** Coerce a requested size to positive integers, falling back to `fallback`. */
function normalizeSize(cols: number | undefined, rows: number | undefined, fallback: Size): Size {
  return {
    cols: clampTerminalDimension(cols, fallback.cols),
    rows: clampTerminalDimension(rows, fallback.rows),
  };
}

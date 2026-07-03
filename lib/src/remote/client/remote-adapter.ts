/**
 * `RemotePtyAdapter` — a {@link PlatformAdapter} backed by a connected
 * {@link PocketClient} session, so the exact mobile terminal UI the website
 * proves out with `FakePtyAdapter` (`PocketTerminalExperience`) can render a
 * real remote Host over the remote-api v1 wire (docs/specs/pocket-app.md). The
 * adapter mapping table is the spec:
 *
 *   onPtyList        ← directory.snapshot   (id = surfaceId)
 *   attach semantics ← surface.attach       (one attachment per session)
 *   onPtyData        ← terminal.data        (base64url utf8 → string)
 *   writePty         → terminal.write       (string → base64url utf8)
 *   resizePty        → terminal.resize
 *   onPtyExit        ← terminal.closed
 *
 * Everything outside that PTY core no-ops or is absent — the interface is built
 * for capability degradation (getCwd/getScrollback → null, getOpenPorts → [],
 * shells/clipboard empty, alerts no-op; alert/TODO/ringing badges instead ride
 * the directory snapshot and are read via {@link getDirectoryEntries}).
 *
 * ── What phase 1b needs to know about terminal-registry (terminal-lifecycle.ts)
 *
 * The registry binds a pane purely by string id: `getOrCreateTerminal(id)`
 * creates an xterm, registers `onPtyData`/`onPtyExit` handlers that filter on
 * `detail.id === id`, and writes matching data straight into that xterm. So the
 * ONLY contract this adapter must honor for the data pump is: emit
 * `onPtyData({ id: surfaceId, data })` / `onPtyExit({ id: surfaceId, ... })` and
 * mount each pane's xterm under a session id equal to its `surfaceId`.
 *
 * `getOrCreateTerminal` also calls `spawnPty(id, {cols,rows})` and, on xterm
 * fit/resize, `resizePty(id, cols, rows)`, and on keystrokes `writePty(id, ..)`.
 * `spawnPty` being a no-op here does NOT break session creation — the registry
 * never waits on a spawn ack; it just wires listeners and calls spawn for the
 * local-PTY adapters. (FakePtyAdapter's `spawnPty` fires an `onPtySpawn` extra
 * the playground's shell registry listens to; there is no such shell registry
 * on the remote side — the Host owns the shell — so we emit nothing on spawn.)
 *
 * The catch phase 1b must handle: nothing is streaming until the pane is
 * ATTACHED. v1 allows one attachment per session, so the UI must call
 * {@link setActivePane}(surfaceId, cols, rows) whenever the active pane changes
 * (detach-old → attach-new). Until then `writePty`/`resizePty` for a
 * non-attached pane are dropped (the Host would reject them anyway), and the
 * attach repaint — not a snapshot transfer — is what fills the client screen.
 * The registry's own `onResize → resizePty` path keeps the attached pane sized;
 * `setActivePane` seeds the first size. Host-initiated `terminal.resize` events
 * are ignored (the PlatformAdapter interface has no inbound-resize channel).
 */

import {
  clampTerminalDimension,
  fromBase64Url,
  toBase64Url,
  utf8Decode,
  utf8Encode,
  type DirectoryEntry,
  type TerminalAttachResult,
} from 'server-lib-common';
import type { PlatformAdapter, PtyInfo, OpenPort } from '../../lib/platform/types';
import type { TerminalHandlers } from './pocket-client';

/**
 * The slice of {@link PocketClient} the adapter drives. A connected
 * `PocketClient` satisfies it structurally; tests pass a network-free fake.
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

const DEFAULT_SIZE: Size = { cols: 80, rows: 24 };

type DataHandler = (detail: { id: string; data: string }) => void;
type ExitHandler = (detail: { id: string; exitCode: number }) => void;
type ListHandler = (detail: { ptys: PtyInfo[] }) => void;
type DirectoryListener = (entries: DirectoryEntry[]) => void;

export class RemotePtyAdapter implements PlatformAdapter {
  readonly #client: RemoteAdapterClient;

  readonly #dataHandlers = new Set<DataHandler>();
  readonly #exitHandlers = new Set<ExitHandler>();
  readonly #listHandlers = new Set<ListHandler>();
  readonly #directoryListeners = new Set<DirectoryListener>();

  /** Latest directory snapshot, in Host order. */
  #entries: DirectoryEntry[] = [];

  /** Memoized directory.watch start; also the "started" guard. */
  #watchPromise: Promise<void> | null = null;
  #directorySubId: string | null = null;

  /** The one attached surface (v1: one attachment per session), or null. */
  #attached: Attachment | null = null;
  /** Bumped on every setActivePane so a superseded async attach can bail. */
  #activeGeneration = 0;
  /** Last size seen, so a re-attach can reuse it if the caller omits one. */
  #lastSize: Size = DEFAULT_SIZE;

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
    const attached = this.#attached;
    this.#attached = null;
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
    void this.#ensureDirectoryWatch();
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
    if (!this.#watchPromise) {
      this.#watchPromise = this.#client
        .watchDirectory((entries) => this.#onSnapshot(entries))
        .then((subId) => {
          this.#directorySubId = subId;
        });
    }
    return this.#watchPromise;
  }

  #onSnapshot(entries: DirectoryEntry[]): void {
    this.#entries = entries;
    this.#emitPtyList();
    for (const listener of this.#directoryListeners) listener(entries);
  }

  #emitPtyList(): void {
    const ptys: PtyInfo[] = this.#entries.map((entry) => ({
      id: entry.surfaceId,
      alive: entry.exitCode === undefined,
      ...(entry.exitCode === undefined ? {} : { exitCode: entry.exitCode }),
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
    const size = normalizeSize(cols, rows, this.#lastSize);
    this.#lastSize = size;

    if (this.#attached?.surfaceId === id) {
      // Already the active surface — a size change is just a resize.
      void this.#client.resize(id, size.cols, size.rows);
      return;
    }

    const generation = ++this.#activeGeneration;
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

    const handlers: TerminalHandlers = {
      onData: (bytes) => this.#emitData(id, bytes),
      onClosed: (exitCode) => this.#emitExit(id, exitCode),
    };
    const { subId } = await this.#client.attach(id, size.cols, size.rows, handlers);
    if (generation !== this.#activeGeneration) {
      // A newer setActivePane won the race — undo this stale attach.
      this.#client.unsubscribe(subId);
      void this.#client.detach(id, subId).catch(() => {});
      return;
    }
    this.#attached = { surfaceId: id, subId };
  }

  /** The currently attached surfaceId, or null. */
  get activeSurfaceId(): string | null {
    return this.#attached?.surfaceId ?? null;
  }

  // --- PTY core ------------------------------------------------------------

  writePty(id: string, data: string): void {
    if (this.#attached?.surfaceId !== id) return; // Host only accepts the attached pane
    void this.#client.write(id, toBase64Url(utf8Encode(data)));
  }

  resizePty(id: string, cols: number, rows: number): void {
    if (this.#attached?.surfaceId !== id) return;
    this.#lastSize = { cols, rows };
    void this.#client.resize(id, cols, rows);
  }

  // Panes are Host-owned: the phone never spawns or kills them.
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

  #emitData(id: string, bytes: string): void {
    const data = utf8Decode(fromBase64Url(bytes));
    for (const handler of this.#dataHandlers) handler({ id, data });
  }

  #emitExit(id: string, exitCode?: number): void {
    if (this.#attached?.surfaceId === id) this.#attached = null;
    for (const handler of this.#exitHandlers) handler({ id, exitCode: exitCode ?? 0 });
  }

  // --- Degraded capabilities (absent PTY features) -------------------------

  async getAvailableShells(): Promise<{ name: string; path: string; args?: string[] }[]> {
    return [];
  }

  async getCwd(): Promise<string | null> {
    return null;
  }

  async getScrollback(): Promise<string | null> {
    return null;
  }

  async getOpenPorts(): Promise<OpenPort[]> {
    return [];
  }

  async readClipboardFilePaths(): Promise<string[] | null> {
    return null;
  }

  async readClipboardImageAsFilePath(): Promise<string | null> {
    return null;
  }

  // Resume-path replay: the Host has no per-pane replay buffer in v1, so ignore.
  onPtyReplay(): void {}
  offPtyReplay(): void {}

  // Host-initiated persistence flush: not driven from the phone.
  onRequestSessionFlush(): void {}
  offRequestSessionFlush(): void {}
  notifySessionFlushComplete(): void {}

  // Alerts are Host-authoritative (surfaced via the directory snapshot), so the
  // phone-side alert controls are inert.
  alertRemove(): void {}
  alertToggle(): void {}
  alertDisable(): void {}
  alertDismiss(): void {}
  alertDismissOrToggle(): void {}
  alertAttend(): void {}
  alertResize(): void {}
  alertClearAttention(): void {}
  alertToggleTodo(): void {}
  alertMarkTodo(): void {}
  alertClearTodo(): void {}
  onAlertState(): void {}
  offAlertState(): void {}

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

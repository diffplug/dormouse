/**
 * What the Tauri sidecar runs beside its PTYs from this bundle: the binding of
 * {@link BurrowService} (`docs/specs/standalone.md` → "Burrow service") and the
 * app's alerts (§Alerts). Stdout is reserved for the JSON-lines bridge, so all
 * logging goes to stderr.
 *
 * The sidecar owns the PTYs, so it is also standalone's terminal-protocol parse
 * site: one parser per PTY generation feeds the webview's `pty:data`, every
 * attached Client, and the app's one `AlertManager` alike
 * (`docs/specs/terminal-escapes.md` → "Parsing location").
 */

import type { ProcessedPtyStream } from '../../lib/processed-pty-stream';
import type { AlertManager, AlertState } from '../../lib/alert-manager';
import type { TerminalColorProvider, TerminalColors } from '../../lib/terminal-protocol';
import { createAlertHost, type AlertRealm } from '../alert-host';
import type { AlertEvents } from '../alert-protocol';
import { alertedPty, createOwnerPtyStream } from '../owner-pty';
import type {
  BurrowSurfaceProvider,
  PtySink,
} from '../../remote/burrow/burrow-surface-provider';
import { createAskSurfaceProvider } from './ask-surface-provider';
import { bakedConnectSrc } from './connect-src';
import { createNativeDirectPeerFactory, disposeNativeDirectPeers } from './native-direct-peer';
import {
  createEphemeralBurrowStateStore,
  FileBurrowStateStore,
  forgetRetiredState,
} from './burrow-state-store';
import { BurrowService } from './service';
import {
  ASK_BUDGET_MS,
  BURROW_ASK_EVENT,
  isBurrowCommand,
  type AnswerParams,
} from './service-protocol';

/** The slice of `pty-core`'s manager the Burrow drives. */
export interface SidecarPtyManager {
  write(id: string, data: string, options?: { paced?: boolean }): void;
  resize(id: string, cols: number, rows: number, repaint?: boolean): void;
  /** Whether the current PTY generation still has a live process. */
  hasPty(id: string): boolean;
}

export interface SidecarSurfaceBridgeOptions {
  /** Writes one JSON line to the Rust bridge, which emits it to the webview. */
  send: (event: string, data: unknown) => void;
  mgr: SidecarPtyManager;
  /** The app's one manager (`createSidecarHost`), fed from the parse below. */
  alerts: AlertManager;
}

export interface SidecarSurfaceBridge {
  provider: BurrowSurfaceProvider;
  /** An `answer` command: contributes to the ask it names, on behalf of the
   *  window `from`. The host stamps that label onto every command it forwards;
   *  a host with one unnamed webview omits it. */
  onAnswer(params: AnswerParams | undefined, from?: string): void;
  /** Which webviews will answer an ask, by host label. Pushed by the host on
   *  every window create and destroy (`docs/specs/standalone.md` -> "Burrow
   *  service"). */
  setWindows(labels: unknown): void;
  /** Which windows one ask actually reached. The host routes an ask naming a
   *  Surface to its owner alone, and only the host knows the owner. */
  setAskDelivery(detail: unknown): void;
  /** A `notify` command: something the directory depends on changed. */
  onNotify(): void;
  /**
   * A `pty-core` event. A `data` event is parsed here and reaches the webview
   * as the events this emits, so `main.js` must not forward it itself.
   */
  onPtyEvent(event: string, data: unknown): void;
  /** A `pty:spawn` command: the id now names a new PTY generation. */
  onPtySpawn(id: unknown): void;
  /**
   * A `pty:themeColors` push. The sidecar has no DOM, so the webview reports its
   * resolved terminal theme for OSC 10/11/12; anything malformed is ignored.
   */
  setThemeColors(colors: unknown): void;
  dispose(): void;
}

/**
 * The provider half: PTYs answered locally, everything about the *view* of them
 * asked of the webview. Separate from {@link createSidecarHost} so it can
 * be driven directly by tests, and so the next Burrow to move into its own process
 * can reuse the ask machinery without the sidecar's file store.
 */
export function createSidecarSurfaceBridge(
  options: SidecarSurfaceBridgeOptions,
): SidecarSurfaceBridge {
  interface PendingAsk {
    /** Every answering window's results, concatenated. */
    results: unknown[];
    /** The windows this ask went to that have not answered yet. A window
     *  answering nothing still empties its entry: what settles the ask is having
     *  heard from everyone, not having found anything. Only ever SHRINKS — a
     *  window that closed mid-fan-out will never answer, and one that opened
     *  never received the ask. */
    awaiting: Set<string>;
    settle(): void;
  }
  const asks = new Map<string, PendingAsk>();
  let askSeq = 0;
  /**
   * Which webviews will answer an ask, by host label. The empty label is the
   * sole unnamed window — a host that never pushes labels (the browser-dev
   * harness, the tests) has exactly one webview, and its answers carry none.
   */
  const SOLE_WINDOW = '';
  let windows = new Set<string>([SOLE_WINDOW]);

  function ask(op: string, params: unknown): Promise<unknown[]> {
    const burrowRequestId = `ask-${++askSeq}`;
    return new Promise((resolve) => {
      const pending: PendingAsk = {
        results: [],
        awaiting: new Set(windows),
        settle: () => {
          clearTimeout(timer);
          asks.delete(burrowRequestId);
          resolve(pending.results);
        },
      };
      const timer = setTimeout(() => {
        // Budget spent. An attach must not hang on a webview that is reloading,
        // and a directory that missed a pane re-collects on the next change.
        // Whatever did answer is still the best available snapshot.
        pending.settle();
      }, ASK_BUDGET_MS);
      // An outstanding ask must never hold the sidecar's event loop open.
      (timer as unknown as { unref?: () => void }).unref?.();
      asks.set(burrowRequestId, pending);
      options.send(BURROW_ASK_EVENT, { burrowRequestId, op, params });
    });
  }

  // The webview's resolved terminal theme, pushed up because this process has no
  // DOM to read it from (`lib/src/lib/platform/vscode-adapter.ts` does the same
  // for the extension host). Null until the first push, which declines the query
  // and leaves it in `visibleData` for xterm.js.
  let themeColors: TerminalColors | null = null;
  const themeColorProvider: TerminalColorProvider = (target) => themeColors?.[target] ?? null;

  interface Stream {
    /**
     * One parser per PTY generation, not per subscription: what an incomplete
     * escape sequence leaves behind belongs to *this* PTY's byte boundaries and
     * must never be mixed with another's. It outlives every attachment because
     * the webview is a consumer too.
     */
    parsed: ProcessedPtyStream;
    /** Each attached sink, holding the unsubscribe from its own subscription. */
    sinks: Map<PtySink, () => void>;
  }
  const streams = new Map<string, Stream>();
  /** Natural exits outlive their process so a late subscription can replay one. */
  const exits = new Map<string, number>();

  /** The parse site for one PTY (`createOwnerPtyStream`), its renderer's share
   *  sent to the webview. */
  function ownerStream(id: string): Stream {
    let stream = streams.get(id);
    if (stream) return stream;
    const parsed = createOwnerPtyStream(id, {
      alerts: options.alerts,
      colorProvider: themeColorProvider,
      onToolEvents: (events) => options.send('terminal:toolEvents', { id, events }),
      onSemanticEvents: (events) => options.send('terminal:semanticEvents', { id, events }),
      // Guarded because a PTY that died between the read and this write throws
      // — `pty-core`'s own `interrupt` wraps the same call — and this runs ahead
      // of the `pty:data` below. Losing the reply is survivable; losing the
      // chunk the webview is about to render is not.
      writeResponse(response) {
        try {
          options.mgr.write(id, response);
        } catch (error) {
          console.error(`[burrow] response write failed for ${id}: ${String(error)}`);
        }
      },
      onChunk: (chunk) => options.send('pty:data', { id, ...chunk }),
    });
    stream = { parsed, sinks: new Map() };
    streams.set(id, stream);
    return stream;
  }

  // A Client's keystrokes and resizes reach the PTY as a local renderer's do.
  const pty = alertedPty(options.alerts, options.mgr);

  const { provider, notifyDirectoryChanged } = createAskSurfaceProvider(ask, {
    // The Burrow has already dropped a mirror's terminal replies, so what
    // reaches here is a human's input.
    writePty: (ptyId, data) => pty.write(ptyId, data, { userInput: true }),
    resizePty: pty.resize,

    streamPty(ptyId, sink) {
      const subscribed = ownerStream(ptyId);
      // One subscription per sink: a sink that attaches while a string control
      // is streaming is held to the next ground byte on its own account
      // (`docs/specs/terminal-escapes.md` → "Parsing location").
      subscribed.sinks.set(sink, subscribed.parsed.subscribe((chunk) => sink.onData(chunk)));
      const unsubscribe = () => {
        // Only while the map still holds the very stream this subscription
        // joined. An exit removes it, and a later attachment to the same id gets
        // a fresh one — so an unsubscribe run twice would silence a stream still
        // flowing. Same guard, same reason, as
        // `vscode-ext/src/processed-pty-streams.ts`.
        if (streams.get(ptyId) !== subscribed) return;
        const stopChunks = subscribed.sinks.get(sink);
        if (!stopChunks) return;
        subscribed.sinks.delete(sink);
        stopChunks();
        // The parser stays: the webview is a consumer of it too, and it is the
        // PTY's generation that owns the byte boundaries, not the attachment.
      };

      // Subscribe first, then inspect the manager on the same event-loop turn.
      // An earlier exit is in `exits`; a later one reaches the sink above. A
      // live result also identifies a new PTY generation that reused this id,
      // so its predecessor's recorded exit can be forgotten safely.
      let alive: boolean;
      try {
        alive = options.mgr.hasPty(ptyId);
      } catch (error) {
        unsubscribe();
        throw error;
      }
      if (alive) {
        exits.delete(ptyId);
      } else {
        const exitCode = exits.get(ptyId) ?? 0;
        unsubscribe();
        // Nothing will feed this parser or retire it: the exit that would have
        // has already been and gone. Without this the sidecar keeps one per
        // surface id that was ever attached to after its PTY died.
        if (subscribed.sinks.size === 0 && streams.get(ptyId) === subscribed) streams.delete(ptyId);
        sink.onExit(exitCode);
      }

      return { stop: unsubscribe, ready: Promise.resolve() };
    },
  });

  return {
    provider,

    /**
     * Collect until every window has answered, or the budget runs out. Each
     * window sees only its own Workspaces, so a directory built from the first
     * answer would list one window's panes and silently omit the rest.
     *
     * Keyed by *who* answered, not by how many have: two answers from one window
     * — a reload racing its own reply — must never settle an ask the other
     * windows have not spoken to.
     */
    onAnswer(params, from = SOLE_WINDOW) {
      if (!params || typeof params.burrowRequestId !== 'string') return;
      const pending = asks.get(params.burrowRequestId);
      if (!pending) {
        // The budget expired before this answer arrived, so the snapshot the
        // Burrow already rendered is missing whatever it names — an empty
        // directory on a machine that does have terminals. Nothing re-opens a
        // settled ask, so mark the directory stale and let the next collect
        // repair it; otherwise an idle machine has no other reason to
        // re-collect and the phone's picker stays wrong indefinitely.
        notifyDirectoryChanged();
        return;
      }
      // Not awaited: either this window already answered, or it opened after the
      // ask went out and never received it. Its results are not this snapshot's.
      if (!pending.awaiting.delete(from)) return;
      if (Array.isArray(params.results)) pending.results.push(...params.results);
      if (pending.awaiting.size === 0) pending.settle();
    },

    setWindows(labels) {
      if (!Array.isArray(labels)) return;
      const live = labels.filter((label): label is string => typeof label === 'string');
      if (live.length === 0) return;
      windows = new Set(live);
      // Re-evaluate what is already out: a window that closed mid-fan-out can
      // never answer, and must not hold an ask open to its whole budget.
      for (const pending of [...asks.values()]) {
        for (const label of pending.awaiting) {
          if (!windows.has(label)) pending.awaiting.delete(label);
        }
        if (pending.awaiting.size === 0) pending.settle();
      }
    },

    /**
     * Narrow one outstanding ask to the windows it was actually delivered to.
     *
     * An ask goes out to every window, because the directory is the union of
     * what they all hold; but an ask naming a Surface is a question exactly one
     * window can answer, and the host routes it there. Waiting on the rest would
     * spend the whole budget on every attach and resize. **Narrows only** —
     * intersected with what is still awaited, so a window that already answered
     * cannot be put back and a late line cannot re-open a settled ask.
     */
    setAskDelivery(detail) {
      const params = detail as { burrowRequestId?: unknown; windows?: unknown } | null;
      if (!params || typeof params.burrowRequestId !== 'string') return;
      if (!Array.isArray(params.windows)) return;
      const pending = asks.get(params.burrowRequestId);
      if (!pending) return;
      const delivered = new Set(
        params.windows.filter((label): label is string => typeof label === 'string'),
      );
      for (const label of pending.awaiting) {
        if (!delivered.has(label)) pending.awaiting.delete(label);
      }
      if (pending.awaiting.size === 0) pending.settle();
    },

    onNotify() {
      notifyDirectoryChanged();
    },

    onPtyEvent(event, data) {
      const detail = data as { id?: unknown } | null;
      if (!detail || typeof detail.id !== 'string') return;
      const id = detail.id;
      if (event === 'data') {
        const chunk = (detail as { data?: unknown }).data;
        if (typeof chunk !== 'string') return;
        // Every PTY is parsed, attached or not: the webview's own output is the
        // other side of this parse.
        ownerStream(id).parsed.write(chunk);
        return;
      }
      if (event !== 'exit') return;
      const reported = (detail as { exitCode?: unknown }).exitCode;
      const exitCode = typeof reported === 'number' ? reported : 0;
      options.alerts.onExit(id, exitCode);
      // Durable: a surface resolution may already be in flight without a sink.
      exits.set(id, exitCode);
      const stream = streams.get(id);
      if (!stream) return;
      // Dropped before the fan-out, so a sink that unsubscribes from inside its
      // own `onExit` finds nothing left to take out. The parser goes with the
      // generation that filled it; a post-exit flush starts a fresh one.
      streams.delete(id);
      for (const sink of stream.sinks.keys()) sink.onExit(exitCode);
    },

    onPtySpawn(id) {
      // A reused id is a new generation: the parser must not carry the last
      // one's half-read sequence into its first bytes, and the new PTY has not
      // exited whatever the old one did.
      if (typeof id !== 'string') return;
      const stream = streams.get(id);
      const exitCode = exits.get(id) ?? 0;
      exits.delete(id);
      if (!stream) return;
      streams.delete(id);
      // `pty-core` lets a spawn displace a live generation without killing it,
      // and any exit it eventually reports belongs to the stream that replaced
      // this one. Close these sinks here or they wait on a PTY that will never
      // be reported to them, leaving the Client on a frozen pane.
      for (const sink of stream.sinks.keys()) sink.onExit(exitCode);
    },

    setThemeColors(colors) {
      const detail = colors as Partial<Record<keyof TerminalColors, unknown>> | null;
      if (!detail) return;
      const { foreground, background, cursor } = detail;
      if (typeof foreground !== 'string') return;
      if (typeof background !== 'string' || typeof cursor !== 'string') return;
      themeColors = { foreground, background, cursor };
    },

    dispose() {
      for (const pending of [...asks.values()]) pending.settle();
      asks.clear();
      streams.clear();
      exits.clear();
    },
  };
}

/** The slice of `pty-core`'s manager the host's own commands drive. */
export interface SidecarHostPtyManager extends SidecarPtyManager {
  spawn(id: string, options?: unknown): void;
  kill(id: string): void;
  gracefulKill(ids: string[], timeout?: unknown): void;
  list(ids: unknown, forWindow: unknown, requestId: unknown, marks: unknown): void;
}

export interface SidecarHostOptions {
  /** Writes one JSON line to the Rust bridge, which routes it
   *  (`docs/specs/standalone.md` → "Routing"). */
  send: (event: string, data: unknown) => void;
  mgr: SidecarHostPtyManager;
  /**
   * Where the enrollment + ACL file lives. The browser dev harness passes a
   * per-run temp dir; standalone passes an empty value only when Rust could not
   * create the app-data directory, which falls back to the in-memory store.
   */
  stateDir?: string;
}

export interface SidecarHost {
  /** The app's one `AlertManager` (`docs/specs/standalone.md` → "Alerts").
   *  `pty-core` reports each helper decision to it. */
  readonly alerts: AlertManager;
  /**
   * One stdin command, if it is this module's — the PTY commands the alerts
   * must see, and every alert and Burrow command. Returns whether it was.
   */
  handleCommand(event: string, data: unknown): boolean;
  /**
   * A `pty-core` event. A `data` event is parsed here and reaches the webview
   * as the events this emits, so `main.js` must not forward it itself.
   */
  onPtyEvent(event: string, data: unknown): void;
  dispose(): void;
}

const isString = (value: unknown): value is string => typeof value === 'string';

/**
 * Everything the sidecar runs beside its PTYs in this bundle: the parse site,
 * the Burrow, and the app's alerts in the host role VS Code's extension host
 * runs too (`lib/src/host/alert-host.ts`), with every window one of its
 * viewers under its label.
 */
export function createSidecarHost(options: SidecarHostOptions): SidecarHost {
  const { send, mgr } = options;
  const alertHost = createAlertHost();
  const alerts = alertHost.manager;

  const sendAlert = <E extends keyof AlertEvents>(event: E, data: AlertEvents[E]) => send(event, data);
  const publishState = (id: string, state: AlertState) => sendAlert('alert:state', { id, ...state });
  const stops = [
    alertHost.watched.subscribe((names) => sendAlert('alert:watchedCommands', { names })),
    alertHost.settings.subscribe((settings) => sendAlert('alert:settings', { settings })),
    alerts.onStateChange(publishState),
  ];

  /** Re-send the listed Sessions' state, every Session's when none are listed;
   *  Rust routes each to its owner. */
  function publish(ids: unknown): void {
    if (!Array.isArray(ids)) {
      for (const [id, state] of alerts.getAllStates()) publishState(id, state);
      return;
    }
    for (const id of ids) {
      if (isString(id) && alerts.has(id)) publishState(id, alerts.getState(id));
    }
  }

  /** An await's outcome goes to the window that parked it; a `sync` re-sends
   *  every Session's state, which reaches only the windows that own them. */
  const realmOf = (window: string): AlertRealm => ({
    answer: (result) => sendAlert('alert:awaitResult', { ...result, forWindow: window }),
    resendStates: () => publish(undefined),
  });

  const store = options.stateDir
    ? new FileBurrowStateStore(options.stateDir)
    : createEphemeralBurrowStateStore((message) => console.error(message));
  // Boot work, not read work: nothing waits on it, and nothing reads what it
  // deletes (`burrow-state-store.ts`).
  if (options.stateDir) void forgetRetiredState(options.stateDir);

  const bridge = createSidecarSurfaceBridge({ send, mgr, alerts });
  const pty = alertedPty(alerts, mgr);

  const service = new BurrowService({
    store,
    provider: bridge.provider,
    kind: 'standalone',
    sendToUi: send,
    connectSrc: bakedConnectSrc(),
    // The one host that answers a `direct-offer` today. Building the factory
    // loads nothing: the addon is opened inside the first offer, if one ever
    // comes (`native-direct-peer.ts`).
    createDirectPeer: createNativeDirectPeerFactory(),
  });
  void service.start().catch((error: unknown) => {
    console.error(`[burrow] failed to start: ${String(error)}`);
  });

  function handleBurrowCommand(data: unknown): void {
    if (!isBurrowCommand(data)) return;
    const command = data;
    // Both of these feed something already waiting on this side, so they
    // answer nothing and never reach the service's dispatch.
    if (command.cmd === 'answer') {
      return bridge.onAnswer(command.params as AnswerParams, command.window);
    }
    if (command.cmd === 'notify') return bridge.onNotify();
    void service.handleCommand(command);
  }

  return {
    alerts,

    handleCommand(event, data) {
      const detail = (data && typeof data === 'object' ? data : {}) as Record<string, unknown>;
      const { id } = detail;
      switch (event) {
        case 'pty:spawn': {
          if (!isString(id)) return true;
          const { alert, ...spawnOptions } = (detail.options ?? {}) as Record<string, unknown>;
          // Before the spawn: the id may be a live PTY's, and nothing the new
          // generation emits may land on the old one's parser or alert state.
          // A cold restore's persisted TODO rides the spawn.
          bridge.onPtySpawn(id);
          alertHost.respawn(id, alert);
          mgr.spawn(id, spawnOptions);
          return true;
        }
        case 'pty:input':
          pty.write(id as string, detail.data as string, {
            paced: detail.paced === true,
            userInput: detail.userInput === true,
          });
          return true;
        case 'pty:resize':
          pty.resize(id as string, detail.cols as number, detail.rows as number);
          return true;
        // Reached only after Rust dropped the id's owner, so the removal's
        // state reaches no window.
        case 'pty:kill':
          if (isString(id)) alerts.remove(id);
          mgr.kill(id as string);
          return true;
        // A closed window's leftover PTYs: gone like a kill, but gracefully.
        // Never `pty:gracefulKill`, which the quit flush sends while windows
        // still own their PTYs.
        case 'pty:reap': {
          const ids = Array.isArray(detail.ids) ? detail.ids.filter(isString) : [];
          for (const reaped of ids) alerts.remove(reaped);
          mgr.gracefulKill(ids, detail.timeout);
          return true;
        }
        // One window's own PTYs, and the answer names it so the host can route
        // the list and every replay behind it back (docs/specs/standalone.md).
        // Their alert state follows, routed to each owner: a reloaded or
        // arriving window has no other way to learn it.
        case 'pty:requestInit':
          mgr.list(detail.ids, detail.forWindow, detail.requestId, detail.marks);
          publish(detail.ids);
          return true;
        case 'alert:command': {
          // Unstamped: there is no window to be a viewer of, or to answer.
          if (!isString(detail.window)) return true;
          const { window, ...command } = detail;
          alertHost.handle(window, command, realmOf(window));
          return true;
        }
        // Which webviews will answer a Burrow ask, and which are still alert
        // viewers (docs/specs/standalone.md -> "Burrow service").
        case 'burrow:windows':
          bridge.setWindows(detail.labels);
          if (Array.isArray(detail.labels)) alertHost.retainRealms(detail.labels.filter(isString));
          return true;
        // Which windows an ask actually reached. Only the host knows: one naming
        // a Surface goes to its owner alone.
        case 'burrow:askDelivered':
          bridge.setAskDelivery(data);
          return true;
        case 'burrow:command':
          handleBurrowCommand(data);
          return true;
        // The webview's resolved terminal theme, so the parser here can answer
        // OSC 10/11/12 (docs/specs/terminal-escapes.md → Supported OSCs).
        case 'pty:themeColors':
          bridge.setThemeColors(data);
          return true;
        default:
          return false;
      }
    },

    onPtyEvent: bridge.onPtyEvent,

    dispose() {
      for (const stop of stops) stop();
      alertHost.dispose();
      service.dispose();
      bridge.dispose();
      // After the service, so no session is still holding a channel: the addon's
      // threads are what would otherwise keep the sidecar from exiting.
      disposeNativeDirectPeers();
    },
  };
}

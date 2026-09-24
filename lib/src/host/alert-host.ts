import { AlertManager, type AwaitHandle, type AwaitOutcome, type Engagement } from '../lib/alert-manager';
import { AlertSettingsHost } from '../lib/alert-settings-host';
import { WatchedCommandHost } from '../lib/watched-command-host';
import type { PersistedAlertState } from '../lib/session-types';
import { ALERT_AWAIT_RESULT_EVENT, ALERT_STATE_EVENT, type AlertAwaitResult } from './alert-protocol';

/**
 * Standalone's one `AlertManager`, in the Node sidecar beside the PTYs and the
 * parse site, exactly as VS Code keeps one in its extension host
 * (`docs/specs/standalone.md` → "Alerts"). Windows are its viewers: each
 * reports engagement, sends the user's verbs, and renders the `alert:state` it
 * is routed. The two app-global stores run the same classes VS Code runs
 * (`vscode-ext/src/message-router.ts`), bound to this manager.
 */

export interface SidecarAlerts {
  /** The one manager. The parse site feeds it (`createSidecarSurfaceBridge`). */
  readonly manager: AlertManager;
  /** One `alert:command` line. */
  handle(command: unknown): void;
  /** Every live window label, pushed on each create and destroy: a window
   *  that is gone engages nothing and waits on nothing. */
  setWindows(labels: unknown): void;
  /** A PTY's helper status as `pty-core` holds it, after a spawn or a promotion. */
  setHelper(id: unknown, helper: boolean): void;
  /** Human input about to be written, in the same message as the write:
   *  acknowledged, echo window opened, before the bytes reach the PTY. */
  acknowledgeInput(id: unknown): void;
  /** Re-send each listed Session's state, every Session when `ids` is absent:
   *  a window collecting its PTYs has no other way to learn it. */
  publish(ids: unknown): void;
  dispose(): void;
}

/** The label a command carries when no host stamped one (a test). */
const UNNAMED_WINDOW = '';

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function createSidecarAlerts(options: {
  /** Writes one event line; the host routes it (`docs/specs/standalone.md` → "Routing"). */
  send: (event: string, data: unknown) => void;
}): SidecarAlerts {
  const { send } = options;
  const manager = new AlertManager();
  const watched = new WatchedCommandHost(manager);
  const settings = new AlertSettingsHost(manager);

  // `dor await`s parked here, by the random id the asking adapter minted.
  const awaits = new Map<string, { handle: AwaitHandle; window: string; startedAt: number }>();
  /** Labels that have reported engagement, so a departed one can be dropped. */
  const viewers = new Set<string>();

  const stops = [
    watched.subscribe((names) => send('alert:watchedCommands', { names })),
    settings.subscribe((value) => send('alert:settings', { settings: value })),
    manager.onStateChange((id, state) => send(ALERT_STATE_EVENT, { id, ...state })),
  ];

  function answer(awaitId: string, window: string, outcome: AwaitOutcome): void {
    send(ALERT_AWAIT_RESULT_EVENT, { awaitId, window, outcome } satisfies AlertAwaitResult);
  }

  function parkAwait(window: string, message: Record<string, unknown>): void {
    const { awaitId, id, until, timeoutMs } = message;
    // A repeated id would owe two answers to one caller; the first keeps it.
    if (!isId(awaitId) || awaits.has(awaitId)) return;
    if (!isId(id) || (until !== 'quiet' && until !== 'exit')) {
      answer(awaitId, window, { kind: 'cancelled', waitedMs: 0 });
      return;
    }
    // `timeoutMs` is revalidated by `awaitCompletion`, which settles nonsense
    // `cancelled` rather than installing it.
    const handle = manager.awaitCompletion(id, { until, timeoutMs: Number(timeoutMs) });
    awaits.set(awaitId, { handle, window, startedAt: Date.now() });
    void handle.promise.then((outcome) => {
      // Gone from the map means `endRealm` already answered it.
      if (awaits.delete(awaitId)) answer(awaitId, window, outcome);
    });
  }

  /**
   * A window's content is gone — reloaded, or the window closed: its
   * engagement ends, and what it parked is cancelled and answered here, once,
   * so no await absorbs completions for a caller that cannot hear the outcome.
   */
  function endRealm(window: string): void {
    viewers.delete(window);
    manager.removeViewer(window);
    for (const [awaitId, parked] of [...awaits]) {
      if (parked.window !== window) continue;
      awaits.delete(awaitId);
      parked.handle.cancel();
      answer(awaitId, window, { kind: 'cancelled', waitedMs: Date.now() - parked.startedAt });
    }
  }

  return {
    manager,

    handle(command) {
      if (!command || typeof command !== 'object') return;
      const message = command as Record<string, unknown>;
      const window = typeof message.window === 'string' ? message.window : UNNAMED_WINDOW;
      const id = message.id;
      switch (message.op) {
        case 'hello':
          endRealm(window);
          return;
        case 'initializeWatchedCommands':
          // Only the first window's offer is taken; every later one is answered
          // with what the host already holds.
          watched.initialize(Array.isArray(message.names) ? message.names.filter(isId) : []);
          return;
        case 'setCommandWatched': {
          const name = typeof message.name === 'string' ? message.name.trim() : '';
          if (!name || typeof message.watched !== 'boolean') return;
          watched.setCommandWatched(name, message.watched);
          return;
        }
        // Revalidated by `normalizeAlertSettings`: a webview must never install a
        // NaN or an absurd timer (`docs/specs/transport.md`).
        case 'initializeSettings':
          settings.initialize(message.settings);
          return;
        case 'updateSettings':
          settings.update(message.settings);
          return;
        case 'engagement': {
          viewers.add(window);
          // `setViewer` revalidates the shape: only a literal `idle` escalates.
          const lapse = message.lapse === 'idle' || message.lapse === 'leave' ? message.lapse : undefined;
          manager.setViewer(window, message.state as Engagement, lapse);
          return;
        }
        case 'await':
          parkAwait(window, message);
          return;
        case 'awaitCancel':
          // The cancelled outcome arrives as `alert:awaitResult` like any other.
          if (isId(message.awaitId)) awaits.get(message.awaitId)?.handle.cancel();
          return;
      }
      if (!isId(id)) return;
      switch (message.op) {
        case 'acknowledge':
          manager.acknowledge(id, { input: false });
          return;
        case 'dismiss':
          manager.dismissAlert(id);
          return;
        case 'toggleTodo':
          manager.toggleTodo(id);
          return;
        case 'clearTodo':
          manager.clearTodo(id);
          return;
        case 'resize':
          manager.onResize(id);
          return;
        case 'remove':
          manager.remove(id);
          return;
        case 'seed':
          if (message.state && typeof message.state === 'object') {
            manager.seed(id, message.state as PersistedAlertState);
          }
          return;
      }
    },

    setWindows(labels) {
      if (!Array.isArray(labels)) return;
      const live = new Set(labels.filter((label): label is string => typeof label === 'string'));
      const known = new Set([...viewers, ...[...awaits.values()].map((parked) => parked.window)]);
      for (const window of known) {
        if (!live.has(window)) endRealm(window);
      }
    },

    setHelper(id, helper) {
      if (isId(id)) manager.setHelper(id, helper);
    },

    acknowledgeInput(id) {
      if (isId(id)) manager.acknowledge(id, { input: true });
    },

    publish(ids) {
      const states = manager.getAllStates();
      const wanted = Array.isArray(ids) ? ids.filter(isId) : [...states.keys()];
      for (const id of wanted) {
        const state = states.get(id);
        if (state) send(ALERT_STATE_EVENT, { id, ...state });
      }
    },

    dispose() {
      for (const stop of stops) stop();
      awaits.clear();
      viewers.clear();
      manager.dispose();
    },
  };
}

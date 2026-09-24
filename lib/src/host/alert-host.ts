import { AlertManager, type AwaitHandle, type Engagement } from '../lib/alert-manager';
import { createAlertDeliveryScheduler, type AlertDelivery } from '../lib/alert-delivery-scheduler';
import { AlertSettingsHost } from '../lib/alert-settings-host';
import { WatchedCommandHost } from '../lib/watched-command-host';
import type { PersistedAlertState } from '../lib/session-types';
import type { AlertAwaitResult } from './alert-protocol';

/**
 * The host role of the alerts, run beside the PTYs by both hosts: VS Code's
 * extension host (`vscode-ext/src/message-router.ts`) and standalone's sidecar
 * (`lib/src/host/remote/sidecar-entry.ts`). One `AlertManager`, the two
 * app-global stores bound to it, and every renderer realm one of its viewers,
 * driving it with `AlertCommand`s (`lib/src/host/alert-protocol.ts`), and the
 * scheduler that decides when a ring is spoken or pushed. How state,
 * snapshots and deliveries reach the realms is each host's own.
 */

/** Where the host answers the realm a command came from. */
export interface AlertRealm {
  /** One await's outcome. May throw from a realm being torn down. */
  answer(result: AlertAwaitResult): void;
  /** `sync`: re-send this realm the state of the Sessions it shows. */
  resendStates(): void;
}

export interface AlertHostOptions {
  /**
   * One due spoken alarm or push, for the realm showing its Session to
   * perform (`docs/specs/alert.md` -> Alarm settings).
   */
  deliver(delivery: AlertDelivery): void;
}

export interface AlertHost {
  readonly manager: AlertManager;
  readonly watched: WatchedCommandHost;
  readonly settings: AlertSettingsHost;
  /** One command from `realmId`, revalidated: nothing a renderer sends is trusted. */
  handle(realmId: string, command: unknown, realm: AlertRealm): void;
  /**
   * The realm's content is gone — disposed, recreated, reloaded, closed: its
   * engagement ends, and what it parked is cancelled and answered here,
   * **synchronously** and once (`docs/specs/alert.md` → Await).
   */
  endRealm(realmId: string): void;
  /** End every realm that is not `live`. */
  retainRealms(live: Iterable<string>): void;
  /**
   * A new PTY generation under `id`: its alert state starts over, from the
   * persisted state a cold restore spawned it with. Before the PTY spawns, so
   * nothing it emits lands on the previous generation's state.
   */
  respawn(id: string, persisted?: unknown): void;
  dispose(): void;
}

interface Parked {
  handle: AwaitHandle;
  realm: AlertRealm;
  startedAt: number;
}

const isId = (value: unknown): value is string => typeof value === 'string' && value.length > 0;

export function createAlertHost(options: AlertHostOptions): AlertHost {
  const manager = new AlertManager();
  const watched = new WatchedCommandHost(manager);
  const settings = new AlertSettingsHost(manager);
  const delivery = createAlertDeliveryScheduler({ manager, defaults: () => settings.current, deliver: options.deliver });
  const stopSettings = settings.subscribe(() => delivery.recheck());
  /** Each realm's parked `dor await`s, by the id its client minted. */
  const parked = new Map<string, Map<string, Parked>>();

  function park(realmId: string, realm: AlertRealm, message: Record<string, unknown>): void {
    const { awaitId, id, until, timeoutMs } = message;
    let awaits = parked.get(realmId);
    // A repeated id would owe two answers to one caller; the first keeps it.
    if (!isId(awaitId) || awaits?.has(awaitId)) return;
    if (!isId(id) || (until !== 'quiet' && until !== 'exit')) {
      realm.answer({ awaitId, outcome: { kind: 'cancelled', waitedMs: 0 } });
      return;
    }
    // `timeoutMs` is revalidated by `awaitCompletion`, which settles nonsense
    // `cancelled` rather than installing it.
    const handle = manager.awaitCompletion(id, { until, timeoutMs: Number(timeoutMs) });
    const entry: Parked = { handle, realm, startedAt: Date.now() };
    if (!awaits) parked.set(realmId, awaits = new Map());
    awaits.set(awaitId, entry);
    void handle.promise.then((outcome) => {
      // Gone, or replaced, means `endRealm` already answered it.
      const current = parked.get(realmId);
      if (current?.get(awaitId) !== entry) return;
      current.delete(awaitId);
      if (current.size === 0) parked.delete(realmId);
      realm.answer({ awaitId, outcome });
    });
  }

  function endRealm(realmId: string): void {
    manager.removeViewer(realmId);
    delivery.endRealm(realmId);
    const awaits = parked.get(realmId);
    if (!awaits) return;
    parked.delete(realmId);
    for (const [awaitId, { handle, realm, startedAt }] of awaits) {
      handle.cancel();
      try {
        realm.answer({ awaitId, outcome: { kind: 'cancelled', waitedMs: Date.now() - startedAt } });
      } catch {
        // A realm being torn down can refuse the answer. Keep cancelling.
      }
    }
  }

  return {
    manager,
    watched,
    settings,

    handle(realmId, command, realm) {
      if (!command || typeof command !== 'object') return;
      const message = command as Record<string, unknown>;
      switch (message.op) {
        case 'hello':
          endRealm(realmId);
          return;
        case 'sync':
          realm.resendStates();
          watched.publish();
          settings.publish();
          return;
        case 'initializeWatchedCommands':
          // Only the first realm's offer is taken; every later one is answered
          // with what the host already holds.
          watched.initialize(Array.isArray(message.names) ? message.names.filter(isId) : []);
          return;
        case 'setCommandWatched': {
          const name = typeof message.name === 'string' ? message.name.trim() : '';
          if (!name || typeof message.watched !== 'boolean') return;
          watched.setCommandWatched(name, message.watched);
          return;
        }
        // Revalidated by `normalizeAlertSettings`: a renderer must never install
        // a NaN or an absurd timer (`docs/specs/transport.md`).
        case 'initializeSettings':
          settings.initialize(message.settings);
          return;
        case 'updateSettings':
          settings.update(message.settings);
          return;
        case 'engagement': {
          // `setViewer` revalidates the shape: only a literal `idle` escalates.
          const lapse = message.lapse === 'idle' || message.lapse === 'leave' ? message.lapse : undefined;
          manager.setViewer(realmId, message.state as Engagement, lapse);
          return;
        }
        case 'deliveryPolicy':
          // Revalidated field by field, like the Workspace's persisted copy.
          delivery.publish(realmId, message.overrides);
          return;
        case 'await':
          park(realmId, realm, message);
          return;
        case 'awaitCancel':
          // The cancelled outcome is answered like any other.
          if (isId(message.awaitId)) parked.get(realmId)?.get(message.awaitId)?.handle.cancel();
          return;
      }
      const id = message.id;
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
      }
    },

    endRealm,

    retainRealms(live) {
      const keep = new Set(live);
      for (const realmId of new Set([...manager.viewerIds(), ...parked.keys()])) {
        if (!keep.has(realmId)) endRealm(realmId);
      }
    },

    respawn(id, persisted) {
      manager.restart(id);
      if (persisted && typeof persisted === 'object') manager.seed(id, persisted as PersistedAlertState);
    },

    dispose() {
      // Cleared first: nothing is answered, or delivered, for a host that is
      // going away.
      parked.clear();
      stopSettings();
      delivery.dispose();
      manager.dispose();
    },
  };
}

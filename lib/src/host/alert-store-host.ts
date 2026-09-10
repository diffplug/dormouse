import { AlertSettingsHost } from '../lib/alert-settings-host';
import { WatchedCommandHost } from '../lib/watched-command-host';
import type { AlertManager } from '../lib/alert-manager';
import type { AlertSettings } from '../lib/alert-settings';

/**
 * The two app-global alert stores, hosted where every window can see them
 * (`docs/specs/alert.md` → "Alarm settings"; `docs/specs/transport.md` → the
 * two-store rule). Standalone became a multi-webview host, so each window can
 * no longer keep its own `localStorage` mirror and call it canonical: the
 * WATCHING rule set and the alarm settings are one per machine.
 *
 * Nothing here rings anything. The sidecar has no `AlertManager` — that lives
 * in each webview — so the targets below are plain memory, and every window
 * applies the broadcast to its own manager.
 *
 * Same classes the VS Code extension host runs
 * (`vscode-ext/src/message-router.ts`), so the two hosts cannot drift.
 */

/** What a renderer asks of the two stores. Mirrors the VS Code message names. */
export type AlertStoreCommand =
  | { op: 'initializeWatchedCommands'; names?: unknown }
  | { op: 'setCommandWatched'; name?: unknown; watched?: unknown }
  | { op: 'initializeSettings'; settings?: unknown }
  | { op: 'updateSettings'; settings?: unknown };

export interface AlertStoreHost {
  /** One `alert:command` line from a webview. */
  handle(command: unknown): void;
  dispose(): void;
}

/** The WATCHING rule set, with no manager behind it. */
class WatchedCommandMemory {
  private names: string[] = [];

  getWatchedCommands(): string[] {
    return [...this.names];
  }

  setWatchedCommands(names: string[]): void {
    this.names = [...new Set(names.filter((name) => typeof name === 'string' && name.length > 0))];
  }

  /** A delta, never a replacement: a stale window must not drop the rules it
   *  has not heard about yet. */
  setCommandWatched(name: string, watched: boolean): void {
    const next = new Set(this.names);
    if (watched) next.add(name);
    else next.delete(name);
    this.names = [...next];
  }
}

/** The alarm settings blob, with no manager behind it. `AlertSettingsHost`
 *  revalidates through `normalizeAlertSettings` before this ever sees it. */
class AlertSettingsMemory {
  settings: AlertSettings | null = null;

  applySettings(settings: AlertSettings): void {
    this.settings = settings;
  }
}

export function createAlertStoreHost(options: {
  /** Writes one event to every window. */
  send: (event: string, data: unknown) => void;
}): AlertStoreHost {
  const watchedMemory = new WatchedCommandMemory();
  const settingsMemory = new AlertSettingsMemory();
  // The classes take an `AlertManager`; they only ever call the three (and one)
  // methods above, which is what lets the sidecar host them with no manager.
  const watched = new WatchedCommandHost(watchedMemory as unknown as AlertManager);
  const settings = new AlertSettingsHost(settingsMemory as unknown as AlertManager);

  const stopWatched = watched.subscribe((names) => options.send('alert:watchedCommands', { names }));
  const stopSettings = settings.subscribe((value) => options.send('alert:settings', { settings: value }));

  return {
    handle(command) {
      const message = command as AlertStoreCommand | null;
      if (!message || typeof message.op !== 'string') return;
      switch (message.op) {
        case 'initializeWatchedCommands':
          // Only the first window's offer is taken; every later one is answered
          // with what the host already holds.
          watched.initialize(Array.isArray(message.names) ? message.names.filter(
            (name): name is string => typeof name === 'string',
          ) : []);
          return;
        case 'setCommandWatched':
          if (typeof message.name !== 'string' || typeof message.watched !== 'boolean') return;
          watched.setCommandWatched(message.name, message.watched);
          return;
        case 'initializeSettings':
          settings.initialize(message.settings);
          return;
        case 'updateSettings':
          settings.update(message.settings);
          return;
        default:
          return;
      }
    },
    dispose() {
      stopWatched();
      stopSettings();
    },
  };
}

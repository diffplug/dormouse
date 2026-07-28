import type { AlertManager } from './alert-manager';

type WatchedCommandTarget = Pick<
  AlertManager,
  'getWatchedCommands' | 'setCommandWatched' | 'setWatchedCommands'
>;

/**
 * Coordinates one host-authoritative WATCHING rule set across multiple
 * renderers. The first renderer seeds persisted state after a fresh host start;
 * later renderers receive that canonical state instead of replacing it.
 * Individual edits are deltas, so a stale renderer cannot drop unrelated rules.
 */
export class WatchedCommandHost {
  private initialized = false;
  private listeners = new Set<(names: string[]) => void>();

  constructor(private readonly target: WatchedCommandTarget) {}

  initialize(names: string[]): void {
    if (!this.initialized) {
      this.initialized = true;
      this.target.setWatchedCommands(names);
    }
    this.publish();
  }

  setCommandWatched(name: string, watched: boolean): void {
    this.initialized = true;
    this.target.setCommandWatched(name, watched);
    this.publish();
  }

  subscribe(listener: (names: string[]) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish(): void {
    const names = this.target.getWatchedCommands();
    for (const listener of this.listeners) listener(names);
  }
}

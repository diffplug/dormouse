/** Listeners to one kind of change, for `useSyncExternalStore`. */
export class Signal {
  private readonly listeners = new Set<() => void>();
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  emit() { for (const listener of this.listeners) listener(); }
}

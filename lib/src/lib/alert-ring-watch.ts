import type { AlertEpisode } from './alert-episode';
import { getActivity, getActivitySnapshot, subscribeToActivity } from './session-activity-store';
import { getAlertDeliveryReceipts, isAlertDeliveryPaused, subscribeToAlertDeliveryOwnership, type AlertSink } from './alert-delivery-state';

/** Shared renderer-side episode→delay→recheck machine for alarm sinks. */
export interface UnattendedRingWatch {
  readonly sink: AlertSink;
  readonly enabled: (sessionId: string) => boolean;
  /** Read on admission; changing a delay never moves an existing deadline. */
  readonly delayMs: (sessionId: string) => number;
  readonly fire: (sessionId: string, episode: AlertEpisode) => void;
  /** Policy changes that must re-run the scan, beside activity and ownership. */
  readonly subscribe: (listener: () => void) => () => void;
  /** Runs after every scan, on the same notifications, so a sink needs no subscriptions of its own. */
  readonly afterScan?: () => void;
}

export function watchUnattendedRings(watch: UnattendedRingWatch): () => void {
  const observed = new Map<string, string | null>();
  const receipts = getAlertDeliveryReceipts(watch.sink);
  const pending = new Map<string, ReturnType<typeof setTimeout>>();
  const cancel = (id: string): void => {
    const timer = pending.get(id);
    if (timer !== undefined) clearTimeout(timer);
    pending.delete(id);
  };
  const onActivityChange = (): void => {
    const snapshot = getActivitySnapshot();
    for (const [id, state] of snapshot) {
      const episode = state.status === 'ALERT_RINGING' ? state.episode : null;
      const previous = observed.get(id);
      observed.set(id, episode?.id ?? null);
      if (!episode) { cancel(id); receipts.delete(id); continue; }
      let receipt = receipts.get(id);
      if (receipt?.episodeId !== episode.id) {
        cancel(id);
        // Fresh means observed after a different episode. First sight seeds
        // silently, and a forgotten receipt on the same episode never re-arms.
        const fresh = previous !== undefined && previous !== episode.id;
        receipt = { episodeId: episode.id, dueAt: episode.startedAt + watch.delayMs(id),
          phase: fresh && watch.enabled(id) ? 'pending' : 'consumed' };
        receipts.set(id, receipt);
      }
      // Disabling consumes the receipt even while suspended for a move.
      if (!watch.enabled(id)) { receipt.phase = 'consumed'; cancel(id); continue; }
      if (isAlertDeliveryPaused(id)) { cancel(id); continue; }
      if (receipt.phase !== 'pending' || pending.has(id)) continue;
      const delivery = receipt;
      pending.set(id, setTimeout(() => {
        pending.delete(id);
        if (getActivity(id).episode?.id !== episode.id || !watch.enabled(id) || isAlertDeliveryPaused(id)) return;
        delivery.phase = 'queued';
        watch.fire(id, episode);
      }, Math.max(0, receipt.dueAt - Date.now())));
    }
    // Receipts outlive a watcher, so prune ids that left while none ran too.
    for (const id of new Set([...observed.keys(), ...receipts.keys()])) {
      if (snapshot.has(id)) continue;
      observed.delete(id);
      cancel(id);
      if (!isAlertDeliveryPaused(id)) receipts.delete(id);
    }
    watch.afterScan?.();
  };
  onActivityChange();
  const stops = [subscribeToActivity(onActivityChange), subscribeToAlertDeliveryOwnership(onActivityChange), watch.subscribe(onActivityChange)];
  return () => {
    stops.forEach((stop) => stop());
    for (const timer of pending.values()) clearTimeout(timer);
    pending.clear();
  };
}

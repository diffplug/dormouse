/** Volatile delivery receipts. They travel only in an explicit live handoff. */
export type AlertSink = 'speech' | 'push';
const SINKS = ['speech', 'push'] as const;
export interface AlertDeliveryReceipt {
  episodeId: string;
  dueAt: number;
  /** `queued` is fired but not yet admitted to the sink; `consumed` never replays. */
  phase: 'pending' | 'queued' | 'consumed';
}
export type AlertDeliveryHandoff = Partial<Record<AlertSink, AlertDeliveryReceipt>>;
const receipts: Record<AlertSink, Map<string, AlertDeliveryReceipt>> = { speech: new Map(), push: new Map() };
const paused = new Set<string>();
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((listener) => listener());
export const getAlertDeliveryReceipts = (sink: AlertSink) => receipts[sink];
export const isAlertDeliveryPaused = (id: string) => paused.has(id);
/** Fires on pause, resume, and forget; a phase change is read at the next scan. */
export function subscribeToAlertDeliveryOwnership(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function pauseAlertDelivery(ids: readonly string[]): void {
  for (const id of ids) paused.add(id);
  notify();
}
export function resumeAlertDelivery(ids: readonly string[]): void {
  for (const id of ids) {
    paused.delete(id);
    for (const sink of SINKS) {
      const receipt = receipts[sink].get(id);
      if (receipt?.phase === 'queued') receipt.phase = 'pending';
    }
  }
  notify();
}
export function snapshotAlertDelivery(id: string): AlertDeliveryHandoff {
  return Object.fromEntries(SINKS.flatMap((sink) => {
    const receipt = receipts[sink].get(id);
    return receipt ? [[sink, { ...receipt }]] : [];
  }));
}
export function restoreAlertDelivery(id: string, handoff: AlertDeliveryHandoff): void {
  for (const sink of SINKS) {
    const receipt = handoff[sink];
    if (receipt) receipts[sink].set(id, { ...receipt, phase: receipt.phase === 'queued' ? 'pending' : receipt.phase });
    else receipts[sink].delete(id);
  }
}
/** Admitted to the sink, or dropped for good: either way this episode never replays. */
export function markAlertConsumed(sink: AlertSink, id: string, episodeId: string): void {
  const receipt = receipts[sink].get(id);
  if (receipt?.episodeId === episodeId) receipt.phase = 'consumed';
}
export function forgetAlertDelivery(ids: readonly string[]): void {
  for (const id of ids) {
    paused.delete(id);
    for (const sink of SINKS) receipts[sink].delete(id);
  }
  notify();
}

/**
 * Renderer-local delivery state for spoken alarms.
 *
 * This deliberately does not live in the persisted Session Activity machine:
 * `speaking` describes the browser speech engine right now, and `spoken` is only
 * a transient acknowledgement that remains while the originating ring is still
 * unresolved. Restores and reconnects must never recreate either state.
 */

export type AlertSpeechState = 'speaking' | 'spoken';

let snapshot = new Map<string, AlertSpeechState>();
const listeners = new Set<() => void>();

export function getAlertSpeechState(sessionId: string): AlertSpeechState | null {
  return snapshot.get(sessionId) ?? null;
}

/** Stable-identity snapshot for `useSyncExternalStore`. */
export function getAlertSpeechSnapshot(): Map<string, AlertSpeechState> {
  return snapshot;
}

export function subscribeToAlertSpeech(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setAlertSpeechState(sessionId: string, state: AlertSpeechState): void {
  if (snapshot.get(sessionId) === state) return;
  snapshot = new Map(snapshot);
  snapshot.set(sessionId, state);
  listeners.forEach((listener) => listener());
}

export function clearAlertSpeechState(sessionId: string): void {
  if (!snapshot.has(sessionId)) return;
  snapshot = new Map(snapshot);
  snapshot.delete(sessionId);
  listeners.forEach((listener) => listener());
}

export function clearAllAlertSpeechStates(): void {
  if (snapshot.size === 0) return;
  snapshot = new Map();
  listeners.forEach((listener) => listener());
}

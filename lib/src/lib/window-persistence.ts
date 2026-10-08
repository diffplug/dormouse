import { readPersistedWindow, type PersistedWindow } from './session-types';

/**
 * The standalone host's stored top-level blob is a `PersistedWindow`
 * (`docs/specs/transport.md` → "Persisted session"). These two functions own the
 * JSON and the storage slot; the Workspace-level composition is the aggregator's
 * (`lib/src/lib/window-session-aggregator.ts`).
 *
 * VS Code does not use this — it persists one bare `PersistedSession` per
 * webview through the extension host's own state APIs.
 */

/**
 * The seam below the shared save/restore code: a single synchronous key/value
 * slot the host persists natively. `localStorage` (browser-dev sidecar) and the
 * standalone `TauriSessionStore` (a Rust-backed, boot-seeded cache) both satisfy
 * it — the same interface, two host-native backings (`docs/specs/standalone.md`
 * §Persistence). `Storage` is a structural superset, so passing `localStorage`
 * still type-checks.
 */
export interface SessionKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

/**
 * Read the stored Window, or null when nothing readable is there. A corrupt blob,
 * or one another build wrote, is discarded so it can never block startup.
 */
export function loadWindowState(storage: SessionKeyValueStore, key: string): PersistedWindow | null {
  return readPersistedWindow(storage.getItem(key));
}

/** Persist `snapshot` under `key`. */
export function saveWindowState(storage: SessionKeyValueStore, key: string, snapshot: PersistedWindow): void {
  storage.setItem(key, JSON.stringify(snapshot));
}

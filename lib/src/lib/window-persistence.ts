import { isRecord } from './is-record';
import {
  readPersistedSession,
  readPersistedWindow,
  wrapSessionInWindow,
  type PersistedWindow,
} from './session-types';

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
 * Read the stored Window, or null when nothing readable is there. A corrupt blob
 * is discarded so a bad save can never block startup.
 *
 * A blob written before standalone persisted Windows is a bare
 * `PersistedSession`; it is wrapped as this Window's one Workspace. That is the
 * only migration — every write since is a Window.
 */
export function loadWindowState(storage: SessionKeyValueStore, key: string): PersistedWindow | null {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  const parsed = parseStoredJson(raw);
  if (parsed === null) return null;
  // Dispatch on the version discriminator rather than trying both readers: each
  // one warns on a shape it does not recognize, and a Window handed to the
  // Session reader would warn on every boot.
  if (isRecord(parsed) && parsed.version === 3) {
    const legacy = readPersistedSession(parsed);
    return legacy ? wrapSessionInWindow(legacy) : null;
  }
  return readPersistedWindow(parsed);
}

/** Persist `snapshot` under `key`. */
export function saveWindowState(storage: SessionKeyValueStore, key: string, snapshot: PersistedWindow): void {
  storage.setItem(key, JSON.stringify(snapshot));
}

/** Parse a stored JSON blob, or null when it is corrupt — a bad blob degrades to a
 *  fresh start rather than throwing at the boot boundary (`docs/specs/transport.md`). */
function parseStoredJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    console.warn('[dormouse] Ignoring corrupt persisted state; starting fresh.');
    return null;
  }
}

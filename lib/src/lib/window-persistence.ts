import { isWorkspacesEnabled } from './feature-flags';
import {
  activeWorkspaceSession,
  readPersistedSession,
  readPersistedWindow,
  replaceActiveSession,
  wrapSessionInWindow,
} from './session-types';

/**
 * Translate between the standalone host's stored top-level blob and the bare
 * `PersistedSession` the shared persistence code (`reconnect.ts`,
 * `session-save.ts`) operates on (stage 2b).
 *
 * With the workspaces flag **off** these are identity passthroughs, so the host
 * stores and restores a bare `PersistedSession` exactly as before. With the flag
 * **on**, the stored blob is a `PersistedWindow`; load returns the active
 * Workspace's session, and save merges the new session back into the active
 * Workspace slot while preserving every other Workspace.
 *
 * The flag is read per call, so toggling it mid-run is consistent within a save
 * or load. (Turning the flag off while a Window is stored makes that blob look
 * unparseable to the bare-session reader — acceptable for a dev-only flag.)
 *
 * Source of truth: `docs/specs/transport.md`. VS Code does not use this — it
 * persists one bare `PersistedSession` per webview.
 */

/** Parsed stored blob → the `PersistedSession` to restore (or null). */
export function activeSessionFromStored(stored: unknown): unknown {
  if (!isWorkspacesEnabled()) return stored;
  const window = readPersistedWindow(stored);
  return window ? activeWorkspaceSession(window) : null;
}

/** Existing stored blob + new active session → the blob to store. */
export function storedValueForSession(existingStored: unknown, session: unknown): unknown {
  if (!isWorkspacesEnabled()) return session;
  const next = readPersistedSession(session);
  if (!next) return session;
  const existingWindow = readPersistedWindow(existingStored);
  return existingWindow ? replaceActiveSession(existingWindow, next) : wrapSessionInWindow(next);
}

/**
 * The seam below the shared save/restore code: a single synchronous key/value
 * slot the host persists natively. `localStorage` (browser-dev sidecar) and the
 * standalone `TauriSessionStore` (a Rust-backed, boot-seeded cache) both satisfy
 * it — the same interface, two host-native backings (`docs/specs/standalone.md`
 * §Persistence). `Storage` is a structural superset, so passing `localStorage`
 * still type-checks. VS Code does not go through here; it persists one bare
 * `PersistedSession` per webview through the extension host's own state APIs.
 */
export interface SessionKeyValueStore {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

// Storage-level round trip shared by the standalone adapters (Tauri + the
// browser-dev sidecar). Owns the JSON parse/stringify and the store access
// so each adapter's get/save collapses to one call instead of re-implementing
// the read-merge-write dance.

/** Read the stored blob and return the `PersistedSession` to restore (or null). */
export function loadSessionState(storage: SessionKeyValueStore, key: string): unknown {
  const raw = storage.getItem(key);
  if (raw === null) return null;
  return activeSessionFromStored(JSON.parse(raw));
}

/** Persist `session` under `key`, merging into the active Workspace when the flag is on. */
export function saveSessionState(storage: SessionKeyValueStore, key: string, session: unknown): void {
  // Flag off (the default): store the bare session without reading the existing
  // blob — its previous value is irrelevant, so skip parsing the (potentially
  // large, scrollback-bearing) stored snapshot.
  if (!isWorkspacesEnabled()) {
    storage.setItem(key, JSON.stringify(session));
    return;
  }
  const raw = storage.getItem(key);
  const existing = raw === null ? null : JSON.parse(raw);
  storage.setItem(key, JSON.stringify(storedValueForSession(existing, session)));
}

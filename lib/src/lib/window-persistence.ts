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

/**
 * What both standalone adapters do identically with the Window: read it out of
 * their key/value slot, write it back, and claim the agent-recovery record for
 * the panes it names.
 *
 * The two differ only in their transport (Tauri `invoke` vs the harness's HTTP
 * bridge) and their store (the Rust-backed `TauriSessionStore` vs
 * `localStorage`), so each supplies those and nothing else
 * (docs/specs/transport.md -> "Persisted session", "Consuming it").
 */

import {
  loadWindowState,
  saveWindowState,
  type SessionKeyValueStore,
} from "dormouse-lib/lib/window-persistence";
import { windowPaneIds, type PersistedWindow } from "dormouse-lib/lib/session-types";

export interface WindowStateSlot {
  /** The stored Window. Parsed once — the store behind it is a boot-seeded
   *  cache, and every write after that comes through `write` below. */
  read(): PersistedWindow | null;
  write(snapshot: PersistedWindow): void;
}

/**
 * The Window slot over `store`. Both halves degrade rather than throw: an
 * unreadable blob is a fresh start, and a failed write is one lost save, never a
 * failed boot or a failed quit.
 */
export function windowStateSlot(
  store: SessionKeyValueStore,
  key: string,
  logPrefix: string,
): WindowStateSlot {
  let current: PersistedWindow | null = null;
  let known = false;
  return {
    read: () => {
      if (!known) {
        known = true;
        try {
          current = loadWindowState(store, key);
        } catch {
          current = null;
        }
      }
      return current;
    },
    write: (snapshot) => {
      known = true;
      current = snapshot;
      try {
        saveWindowState(store, key, snapshot);
      } catch {
        console.error(`[${logPrefix}] Failed to save session state`);
      }
    },
  };
}

/**
 * Claim the resume invocations the last teardown captured for the panes `saved`
 * names. Destructive in the sidecar on the first call, so a relaunch that gets
 * this far can never replay them.
 *
 * A record that could not be read is one restore without auto-resume, never a
 * failed boot.
 */
export async function claimRecoveryCommands(
  take: (paneIds: string[]) => Promise<Record<string, string> | null | undefined>,
  saved: PersistedWindow | null,
  logPrefix: string,
): Promise<Record<string, string>> {
  const paneIds = windowPaneIds(saved);
  if (paneIds.length === 0) return {};
  try {
    return (await take(paneIds)) ?? {};
  } catch (err) {
    console.error(`[${logPrefix}] take_recovery_commands failed:`, err);
    return {};
  }
}

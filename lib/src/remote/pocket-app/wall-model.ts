/**
 * Pure glue between a remote `directory.snapshot` and the mobile wall UI. Kept
 * free of React and the terminal registry so it is unit-testable in isolation
 * (`wall-model.test.ts`).
 *
 * Two shapes come out of one directory snapshot:
 *   - {@link directoryWallSessions} — the `{id,title}` list `MobileWall` renders
 *     (which pane is live + its header title).
 *   - {@link directorySessionItems} — the badge-carrying items the session list
 *     in `MobileTerminalUi` shows. On the remote side, badge state is
 *     Host-authoritative and rides the directory (not local terminal parsing),
 *     so this replaces `useMobileWallSessionItems` rather than layering on it.
 */

import type { DirectoryEntry } from 'server-lib-common';
import type { MobileWallSession } from '../../components/MobileWall';
import type { MobileTerminalSessionItem } from '../../components/MobileTerminalUi';
import type { SessionStatus } from '../../lib/terminal-registry';

const DEFAULT_TITLE = 'Terminal';

/** Title for a surface, falling back to a friendly default when the Host sends none. */
function paneTitle(entry: DirectoryEntry): string {
  return entry.title || DEFAULT_TITLE;
}

/** The `{id,title}` sessions `MobileWall` mounts, in Host order. */
export function directoryWallSessions(entries: DirectoryEntry[]): MobileWallSession[] {
  return entries.map((entry) => ({ id: entry.surfaceId, title: paneTitle(entry) }));
}

/**
 * Map the directory snapshot onto the affordances a {@link MobileTerminalSessionItem}
 * exposes: `ringing` → `ALERT_RINGING` (the only status the session list renders
 * a bell for), `hasTODO` → the TODO pill, and `cwd`/`activity` → the secondary
 * line. `id` is the surfaceId so the registry binds each pane's xterm by it.
 */
export function directorySessionItems(
  entries: DirectoryEntry[],
  activeSurfaceId: string | null,
): MobileTerminalSessionItem[] {
  return entries.map((entry) => ({
    id: entry.surfaceId,
    title: paneTitle(entry),
    secondary: secondaryLine(entry),
    active: entry.surfaceId === activeSurfaceId,
    status: statusFor(entry),
    todo: entry.hasTODO,
  }));
}

function statusFor(entry: DirectoryEntry): SessionStatus | undefined {
  return entry.ringing ? 'ALERT_RINGING' : undefined;
}

function secondaryLine(entry: DirectoryEntry): string | null {
  if (entry.cwd) return entry.cwd;
  if (entry.activity && entry.activity !== 'unknown') return entry.activity;
  return null;
}

export interface PaneDims {
  cols: number;
  rows: number;
}

/** The slice of {@link RemotePtyAdapter} the wall drives on an active-pane change. */
export interface PaneActivator {
  setActivePane(id: string, cols?: number, rows?: number): Promise<void> | void;
}

/**
 * Attach `id` as the active pane, forwarding the pane's current dims when known
 * (else the adapter defaults and the registry's resize path corrects it), then
 * run `onAttached` — the wall uses it to refit xterm through the now-valid,
 * attached resize path. Awaiting keeps the refit strictly after the attach.
 */
export async function activatePane(
  adapter: PaneActivator,
  id: string,
  dims: PaneDims | null,
  onAttached?: (id: string) => void,
): Promise<void> {
  await Promise.resolve(adapter.setActivePane(id, dims?.cols, dims?.rows));
  onAttached?.(id);
}

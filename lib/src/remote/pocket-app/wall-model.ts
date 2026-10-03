/** Pure directory-snapshot → mobile-wall projection; see `docs/specs/pocket-app.md`. */

import type { DirectoryEntry } from 'remote-lib-common';
import type { MobileWallSession } from '../../components/MobileWall';
import type { MobileTerminalSessionGroup, MobileTerminalSessionItem } from '../../components/MobileTerminalUi';
import type { SessionStatus } from '../../lib/terminal-registry';

const DEFAULT_TITLE = 'Terminal';
/** The group of panes the Burrow named no Workspace for: a header beside ones it
 *  did, and none when it named none, since a list of one group is flat. */
const UNGROUPED: MobileTerminalSessionGroup = { id: '', label: 'Other' };

/** Title for a surface, falling back to a friendly default when the Burrow sends none. */
function paneTitle(entry: DirectoryEntry): string {
  return entry.title || DEFAULT_TITLE;
}

export function attachableDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return entries.filter((entry) => entry.alive);
}

/**
 * The attachable entries in picker order: each Workspace's panes together,
 * Workspaces a Window shows first, then the Burrow's own order, and panes it
 * named no Workspace for last. Without Workspaces this is Burrow order.
 */
export function pickerEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  const groups = new Map<string | undefined, { rank: number; entries: DirectoryEntry[] }>();
  for (const entry of attachableDirectoryEntries(entries)) {
    const { workspace } = entry;
    const key = workspace?.ref;
    let group = groups.get(key);
    if (!group) {
      group = { rank: workspace ? (workspace.active ? 0 : 1) : 2, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  // Stable, so equal ranks keep the order the Burrow sent them in.
  return [...groups.values()].sort((a, b) => a.rank - b.rank).flatMap((group) => group.entries);
}

/** The `{id,title}` sessions `MobileWall` mounts, in Burrow order. */
export function directoryWallSessions(entries: DirectoryEntry[]): MobileWallSession[] {
  return attachableDirectoryEntries(entries).map((entry) => ({
    id: entry.surfaceId,
    title: paneTitle(entry),
  }));
}

/**
 * Map the directory snapshot onto the affordances a {@link MobileTerminalSessionItem}
 * exposes: `ringing` → `ALERT_RINGING` (the only status the session list wears
 * the alarm inset for), `hasTODO` → the TODO pill, and `cwd`/`activity` → the
 * secondary line. `id` is the surfaceId so the registry binds each pane's xterm
 * by it.
 */
export function directorySessionItems(
  entries: DirectoryEntry[],
  activeSurfaceId: string | null,
): MobileTerminalSessionItem[] {
  return attachableDirectoryEntries(entries).map((entry) => ({
    id: entry.surfaceId,
    group: entry.workspace ? { id: entry.workspace.ref, label: entry.workspace.name } : UNGROUPED,
    title: paneTitle(entry),
    secondary: secondaryLine(entry),
    active: entry.surfaceId === activeSurfaceId,
    status: statusFor(entry),
    // `DirectoryEntry.ringing` is an edgeless boolean, so a remote ring has no
    // start to clock an arrival burst from; the row wears the static inset.
    episode: null,
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

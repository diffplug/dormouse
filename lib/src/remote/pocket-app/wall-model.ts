/** Pure directory-snapshot → mobile-wall projection; see `docs/specs/pocket-app.md`. */

import type { DirectoryEntry, DirectoryWorkspace } from 'remote-lib-common';
import type { MobileWallSession } from '../../components/MobileWall';
import type { MobileTerminalSessionGroup, MobileTerminalSessionItem } from '../../components/MobileTerminalUi';
import type { SessionStatus } from '../../lib/terminal-registry';

const DEFAULT_TITLE = 'Terminal';
/** The header over panes the Burrow named no Workspace for, beside ones it did. */
const UNGROUPED_LABEL = 'Other';

/** Title for a surface, falling back to a friendly default when the Burrow sends none. */
function paneTitle(entry: DirectoryEntry): string {
  return entry.title || DEFAULT_TITLE;
}

export function attachableDirectoryEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  return entries.filter((entry) => entry.alive);
}

/** The entry's Workspace when it is well formed; a Burrow too old to send one sends none. */
function workspaceOf(entry: DirectoryEntry): DirectoryWorkspace | undefined {
  const workspace = entry.workspace as Partial<DirectoryWorkspace> | undefined;
  if (typeof workspace?.ref !== 'string' || typeof workspace.name !== 'string') return undefined;
  return { ref: workspace.ref, name: workspace.name, active: workspace.active === true };
}

/**
 * The attachable entries in picker order: each Workspace's panes together,
 * Workspaces a Window shows first, then the Burrow's own order, and panes it
 * named no Workspace for last. Without Workspaces this is Burrow order.
 */
export function pickerEntries(entries: DirectoryEntry[]): DirectoryEntry[] {
  const groups = new Map<string | undefined, { rank: number; entries: DirectoryEntry[] }>();
  for (const entry of attachableDirectoryEntries(entries)) {
    const workspace = workspaceOf(entry);
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
  const attachable = attachableDirectoryEntries(entries);
  // Grouped only once the Burrow names a Workspace; until then the list is flat.
  const grouped = attachable.some((entry) => workspaceOf(entry) !== undefined);
  return attachable.map((entry) => ({
    id: entry.surfaceId,
    ...(grouped ? { group: groupFor(entry) } : {}),
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

function groupFor(entry: DirectoryEntry): MobileTerminalSessionGroup {
  const workspace = workspaceOf(entry);
  return workspace ? { id: workspace.ref, label: workspace.name } : { id: '', label: UNGROUPED_LABEL };
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

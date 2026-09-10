import { getWorkspacesSnapshot, subscribeToWorkspaces } from './workspace-store';
import type { PersistedSession, PersistedWindow, PersistedWorkspace, WorkspaceId } from './session-types';

/**
 * Collects each Workspace's latest `PersistedSession` into one `PersistedWindow`
 * and hands it to the host (`docs/specs/transport.md` → "Persisted session").
 * The Wall's persistence hook publishes here instead of writing the platform
 * slot when it runs under a Workspace; the standalone boot installs the writer.
 *
 * One record per Workspace, whatever its age: boot seeds it from what the last
 * run left on disk, and that Workspace's Wall replaces it on its first save. The
 * seed is what keeps a Window snapshot taken mid-boot from replacing a restored
 * Workspace with a blank one, and it is what that first save reads its retained
 * `cwd` out of (`previousWorkspaceSession`).
 */

const records = new Map<WorkspaceId, PersistedSession>();
let writer: ((snapshot: PersistedWindow) => void | Promise<void>) | null = null;
let unsubscribeWorkspaces: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

/**
 * How long a debounced save waits. One value for both levels: a Wall's own
 * record and the Window blob its publish schedules. The Window's wait is what
 * collapses N Workspaces reacting to one event into a single host write.
 *
 * Source of truth for the Wall's timer: `useSessionPersistence` in
 * `lib/src/components/wall/use-session-persistence.ts`.
 */
export const SESSION_SAVE_DEBOUNCE_MS = 500;

/**
 * The record on disk for every Workspace this Window is restoring, installed at
 * boot before any Wall mounts. Replaces whatever was seeded before; `null`
 * clears it (a fresh Window).
 */
export function seedWindowSession(snapshot: PersistedWindow | null): void {
  records.clear();
  for (const workspace of snapshot?.workspaces ?? []) records.set(workspace.id, workspace.session);
}

/** Record a Workspace's latest session and schedule the Window write. Also how a
 *  Workspace arriving from another Window installs the record it brought. */
export function publishWorkspaceSession(workspaceId: WorkspaceId, session: PersistedSession): void {
  records.set(workspaceId, session);
  scheduleWrite();
}

/** Drop a Workspace's session (its Workspace was closed or moved away). */
export function forgetWorkspaceSession(workspaceId: WorkspaceId): void {
  if (!records.delete(workspaceId)) return;
  scheduleWrite();
}

/**
 * This Workspace's last persisted record — what its Wall published, or what boot
 * seeded until then. A save's previous-pane map reads a dead PTY's retained
 * `cwd` and `alert` out of it, so answering with the Window's active Workspace
 * (or with nothing) would drop them on the first save after a restore.
 */
export function previousWorkspaceSession(workspaceId: WorkspaceId): PersistedSession | null {
  return records.get(workspaceId) ?? null;
}

/**
 * The Window as it stands: Workspaces in strip order carrying the id, name, and
 * latest session of each. A Workspace with no record at all is omitted rather
 * than written empty.
 */
export function getWindowSnapshot(): PersistedWindow {
  const { workspaces, activeId } = getWorkspacesSnapshot();
  const collected: PersistedWorkspace[] = [];
  for (const workspace of workspaces) {
    const session = previousWorkspaceSession(workspace.id);
    if (!session) continue;
    collected.push({ id: workspace.id, name: workspace.name, session });
  }
  return { version: 1, workspaces: collected, activeWorkspaceId: activeId };
}

/**
 * Install the sink that persists a Window snapshot; returns its uninstaller.
 * Replace-on-repeat: only one writer is live, so a re-install cannot double-write.
 *
 * Installing also subscribes to the Workspace store, because reordering,
 * renaming, and switching the active Workspace all change the blob without any
 * Session changing.
 */
export function installWindowSessionWriter(write: (snapshot: PersistedWindow) => void | Promise<void>): () => void {
  writer = write;
  unsubscribeWorkspaces?.();
  unsubscribeWorkspaces = subscribeToWorkspaces(scheduleWrite);
  return () => {
    if (writer !== write) return;
    writer = null;
    unsubscribeWorkspaces?.();
    unsubscribeWorkspaces = null;
    cancelPending();
  };
}

/**
 * Write now and resolve when the host has taken the snapshot. The quit teardown's
 * step between the last Wall flush and the host's own drain — a debounce timer
 * still pending at exit would otherwise lose the final save.
 */
export async function flushWindowSession(): Promise<void> {
  cancelPending();
  writeNow();
  // Not a loop: `writeNow` is synchronous up to the writer's own promise, and
  // nothing schedules behind it once the timer is cancelled.
  await inFlight;
}

function scheduleWrite(): void {
  if (!writer || timer) return;
  timer = setTimeout(() => {
    timer = null;
    writeNow();
  }, SESSION_SAVE_DEBOUNCE_MS);
}

function writeNow(): void {
  if (!writer) return;
  const result = writer(getWindowSnapshot());
  inFlight = result ? Promise.resolve(result).catch(() => undefined) : null;
}

function cancelPending(): void {
  if (!timer) return;
  clearTimeout(timer);
  timer = null;
}

/** Forget every session, seed, and installed writer (tests). */
export function resetWindowSessionAggregator(): void {
  records.clear();
  writer = null;
  unsubscribeWorkspaces?.();
  unsubscribeWorkspaces = null;
  cancelPending();
  inFlight = null;
}

import { getWorkspacesSnapshot, subscribeToWorkspaces } from './workspace-store';
import type { PersistedSession, PersistedWindow, PersistedWorkspace, WorkspaceId } from './session-types';

/**
 * Collects each Workspace's latest `PersistedSession` into one `PersistedWindow`
 * and hands it to the host (`docs/specs/transport.md` → "Persisted session").
 * The Wall's persistence hook publishes here instead of writing the platform
 * slot when it runs under a Workspace; the standalone boot installs the writer.
 *
 * Two maps, because a Workspace's record has two possible ages. `published` is
 * what its Wall has saved this run. `seeded` is what the last run left on disk,
 * which is the answer until that Wall has saved anything — it is what keeps a
 * Window snapshot taken mid-boot from replacing a restored Workspace with a
 * blank one, and it is what a save reads its retained `cwd` out of
 * (`previousWorkspaceSession`).
 */

const published = new Map<WorkspaceId, PersistedSession>();
const seeded = new Map<WorkspaceId, PersistedSession>();
let writer: ((snapshot: PersistedWindow) => void | Promise<void>) | null = null;
let unsubscribeWorkspaces: (() => void) | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;

/** How long the Window blob waits for its Workspaces to settle. Each Wall
 *  already debounces its own record, so this is what collapses N Workspaces
 *  reacting to one event into a single host write. */
const WRITE_DEBOUNCE_MS = 500;

/**
 * The record on disk for every Workspace this Window is restoring, installed at
 * boot before any Wall mounts. Replaces whatever was seeded before; `null`
 * clears it (a fresh Window).
 */
export function seedWindowSession(window: PersistedWindow | null): void {
  seeded.clear();
  for (const workspace of window?.workspaces ?? []) seeded.set(workspace.id, workspace.session);
}

/** Record a Workspace's latest session and schedule the Window write. */
export function publishWorkspaceSession(workspaceId: WorkspaceId, session: PersistedSession): void {
  published.set(workspaceId, session);
  scheduleWrite();
}

/**
 * Install a record for a Workspace whose Wall is not the one that built it — a
 * Workspace moving in from another Window. It stands as that Workspace's
 * previous record until its new Wall publishes, exactly as a seed does.
 */
export function adoptWorkspaceSession(workspaceId: WorkspaceId, session: PersistedSession): void {
  seeded.set(workspaceId, session);
  published.delete(workspaceId);
  scheduleWrite();
}

/** Drop a Workspace's session (its Workspace was closed or moved away). */
export function forgetWorkspaceSession(workspaceId: WorkspaceId): void {
  const had = published.delete(workspaceId);
  if (!seeded.delete(workspaceId) && !had) return;
  scheduleWrite();
}

/**
 * This Workspace's last persisted record — what its Wall published, or what boot
 * seeded until then. A save's previous-pane map reads a dead PTY's retained
 * `cwd` and `alert` out of it, so answering with the Window's active Workspace
 * (or with nothing) would drop them on the first save after a restore.
 */
export function previousWorkspaceSession(workspaceId: WorkspaceId): PersistedSession | null {
  return published.get(workspaceId) ?? seeded.get(workspaceId) ?? null;
}

/**
 * The Window as it stands: Workspaces in strip order carrying the id, name, and
 * latest session of each. A Workspace with neither a published nor a seeded
 * session is omitted rather than written empty.
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
  }, WRITE_DEBOUNCE_MS);
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
  published.clear();
  seeded.clear();
  writer = null;
  unsubscribeWorkspaces?.();
  unsubscribeWorkspaces = null;
  cancelPending();
  inFlight = null;
}

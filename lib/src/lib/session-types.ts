import type { DoorDirection } from './spatial-nav';
import type { SessionStatus } from './activity-monitor';
import { ACTIVITY_NOTIFICATION_SOURCES, migrateTodoState, type ActivityNotification, type TodoState } from './alert-manager';

export interface PersistedAlertState {
  status: SessionStatus;
  watchingEnabled?: boolean;
  todo: TodoState;
  notification?: ActivityNotification | null;
}

/**
 * Surface kind recorded per pane (`docs/specs/glossary.md`). Absent reads as
 * `'terminal'`. A `'browser'` pane has no PTY, scrollback, or registry entry; it
 * is reconstructed from the dockview `layout` blob, so restore/resume must route
 * it differently from a terminal (see `session-restore.ts`, `reconnect.ts`).
 */
export type PersistedSurfaceType = 'terminal' | 'browser';

export interface PersistedPane {
  id: string;
  cwd: string | null;
  title: string;
  scrollback: string | null;
  resumeCommand: string | null;
  untouched: boolean;
  alert?: PersistedAlertState | null;
  surfaceType?: PersistedSurfaceType;
}

/**
 * Build the persisted record for a browser surface. Browser panes have no PTY,
 * so the terminal-only fields (cwd/scrollback/resumeCommand/untouched) are always
 * blank; the dockview `layout` blob reconstructs the surface and `alert` carries
 * the optional TODO. Single source of truth shared by the renderer save path
 * (`session-save.ts`) and the VS Code host refresh (`vscode-ext/session-state.ts`).
 */
export function browserPersistedPane(
  pane: { id: string; title: string },
  alert: PersistedAlertState | null,
): PersistedPane {
  return {
    id: pane.id,
    title: pane.title,
    cwd: null,
    scrollback: null,
    resumeCommand: null,
    untouched: false,
    alert,
    surfaceType: 'browser',
  };
}

export interface PersistedDoor {
  id: string;
  title: string;
  component?: string;
  tabComponent?: string;
  params?: Record<string, unknown>;
  neighborId: string | null;
  direction: DoorDirection;
  remainingPaneIds: string[];
  layoutAtMinimize: unknown;
  layoutAtMinimizeSignature: string;
}

export interface PersistedSession {
  version: 3;
  panes: PersistedPane[];
  doors?: PersistedDoor[];
  layout: unknown; // SerializedDockview — kept as `unknown` to avoid dockview dep in types
}

export type WorkspaceId = string;

/**
 * A named Workspace (one Wall's worth of Surfaces + its layout) as persisted
 * inside a `PersistedWindow` (`docs/specs/glossary.md`). Stage 2b. The inner
 * `session` keeps its own v3 versioning; the Window wraps it.
 */
export interface PersistedWorkspace {
  id: WorkspaceId;
  name: string;
  session: PersistedSession;
}

/**
 * The standalone Window's persisted snapshot: an ordered list of Workspaces and
 * which one is active. VS Code does NOT use this — each webview persists exactly
 * one bare `PersistedSession` (`docs/specs/vscode.md`). Stage 2b.
 */
export interface PersistedWindow {
  version: 1;
  workspaces: PersistedWorkspace[];
  activeWorkspaceId: WorkspaceId;
}

/** Default id/name for the single Workspace a pre-workspace snapshot migrates to. */
export const DEFAULT_WORKSPACE_ID: WorkspaceId = 'workspace-1';
export const DEFAULT_WORKSPACE_NAME = 'Workspace 1';

type PersistedPaneInput = Omit<PersistedPane, 'untouched'> & { untouched?: boolean };

interface PersistedSessionV3Input {
  version: 3;
  panes: PersistedPaneInput[];
  doors?: PersistedDoor[];
  layout: unknown;
}

// --- Legacy v2 shapes (read-only, for migration) ---

export interface PersistedAlertStateV2 {
  status: SessionStatus;
  todo: unknown; // numeric encoding: -1=off, [0,1]=soft, 2=hard
}

export interface PersistedPaneV2 {
  id: string;
  cwd: string | null;
  title: string;
  scrollback: string | null;
  resumeCommand: string | null;
  alert?: PersistedAlertStateV2 | null;
}

export interface PersistedSessionV2 {
  version: 2;
  panes: PersistedPaneV2[];
  doors?: PersistedDoor[];
  layout: unknown;
}

// --- Legacy v1 shapes (read-only, for migration) ---

export interface PersistedDoorV1 {
  id: string;
  title: string;
  neighborId: string | null;
  direction: DoorDirection;
  remainingPanelIds: string[];
  restoreLayout: unknown;
  detachedLayoutSignature: string;
}

export interface PersistedSessionV1 {
  version: 1;
  panes: PersistedPaneV2[];
  detached?: PersistedDoorV1[];
  layout: unknown;
}

// --- Validation guards (reject untrusted blobs) ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPersistedAlertShape(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (typeof value.status !== 'string') return false;
  if (value.watchingEnabled !== undefined && typeof value.watchingEnabled !== 'boolean') return false;
  const t = value.todo;
  if (!(typeof t === 'boolean' || typeof t === 'number' || typeof t === 'string')) return false;
  return value.notification === undefined || value.notification === null || isActivityNotificationShape(value.notification);
}

function isActivityNotificationShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (ACTIVITY_NOTIFICATION_SOURCES as readonly string[]).includes(value.source as string) &&
    (typeof value.title === 'string' || value.title === null) &&
    (typeof value.body === 'string' || value.body === null)
  );
}

function isPersistedPaneShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.cwd === 'string' || value.cwd === null) &&
    (typeof value.scrollback === 'string' || value.scrollback === null) &&
    (typeof value.resumeCommand === 'string' || value.resumeCommand === null) &&
    (value.untouched === undefined || typeof value.untouched === 'boolean') &&
    (value.surfaceType === undefined || value.surfaceType === 'terminal' || value.surfaceType === 'browser') &&
    (value.alert === undefined || isPersistedAlertShape(value.alert))
  );
}

function isPersistedDoorV1(value: unknown): value is PersistedDoorV1 {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.neighborId === 'string' || value.neighborId === null) &&
    typeof value.direction === 'string' &&
    Array.isArray(value.remainingPanelIds) &&
    value.remainingPanelIds.every((id) => typeof id === 'string') &&
    typeof value.detachedLayoutSignature === 'string'
  );
}

function isPersistedDoor(value: unknown): value is PersistedDoor {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.neighborId === 'string' || value.neighborId === null) &&
    (value.component === undefined || typeof value.component === 'string') &&
    (value.tabComponent === undefined || typeof value.tabComponent === 'string') &&
    (value.params === undefined || isRecord(value.params)) &&
    typeof value.direction === 'string' &&
    Array.isArray(value.remainingPaneIds) &&
    value.remainingPaneIds.every((id) => typeof id === 'string') &&
    typeof value.layoutAtMinimizeSignature === 'string'
  );
}

function isPersistedSessionV1(value: unknown): value is PersistedSessionV1 {
  if (!isRecord(value) || value.version !== 1) return false;
  return (
    Array.isArray(value.panes) &&
    value.panes.every(isPersistedPaneShape) &&
    (value.detached === undefined || (Array.isArray(value.detached) && value.detached.every(isPersistedDoorV1))) &&
    'layout' in value
  );
}

function isPersistedSessionV2(value: unknown): value is PersistedSessionV2 {
  if (!isRecord(value) || value.version !== 2) return false;
  return (
    Array.isArray(value.panes) &&
    value.panes.every(isPersistedPaneShape) &&
    (value.doors === undefined || (Array.isArray(value.doors) && value.doors.every(isPersistedDoor))) &&
    'layout' in value
  );
}

function isPersistedSessionV3(value: unknown): value is PersistedSessionV3Input {
  if (!isRecord(value) || value.version !== 3) return false;
  return (
    Array.isArray(value.panes) &&
    value.panes.every(isPersistedPaneShape) &&
    (value.doors === undefined || (Array.isArray(value.doors) && value.doors.every(isPersistedDoor))) &&
    'layout' in value
  );
}

// --- Migrations ---

export function migrateSessionV1toV2(v1: PersistedSessionV1): PersistedSessionV2 {
  return {
    version: 2,
    panes: v1.panes,
    layout: v1.layout,
    doors: (v1.detached ?? []).map((door) => ({
      id: door.id,
      title: door.title,
      neighborId: door.neighborId,
      direction: door.direction,
      remainingPaneIds: door.remainingPanelIds,
      layoutAtMinimize: door.restoreLayout,
      layoutAtMinimizeSignature: door.detachedLayoutSignature,
    })),
  };
}

export function migrateSessionV2toV3(v2: PersistedSessionV2): PersistedSession {
  return {
    version: 3,
    layout: v2.layout,
    doors: v2.doors,
    panes: v2.panes.map((pane) => ({
      ...pane,
      untouched: false,
      alert: pane.alert
        ? { status: pane.alert.status, todo: migrateTodoState(pane.alert.todo) }
        : pane.alert,
    })),
  };
}

export function readPersistedSession(raw: unknown): PersistedSession | null {
  const value = parseJsonString(raw);
  if (!isRecord(value)) return null;
  if (isPersistedSessionV3(value)) return normalizeSessionV3(value);
  if (isPersistedSessionV2(value)) return migrateSessionV2toV3(value);
  if (isPersistedSessionV1(value)) return migrateSessionV2toV3(migrateSessionV1toV2(value));
  return null;
}

function normalizeSessionV3(session: PersistedSessionV3Input): PersistedSession {
  if (session.panes.every((pane) => typeof pane.untouched === 'boolean')) {
    return session as PersistedSession;
  }
  return {
    ...session,
    panes: session.panes.map((pane) => ({
      ...pane,
      untouched: pane.untouched ?? false,
    })),
  };
}

function parseJsonString(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

// --- Window container (stage 2b) ---

// Structural check only — id/name strings and a session object. Whether the
// inner session is actually readable is decided per-Workspace in
// readPersistedWindow, which drops unreadable ones rather than rejecting the
// whole Window.
function isPersistedWorkspaceShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return typeof value.id === 'string' && typeof value.name === 'string' && isRecord(value.session);
}

function isPersistedWindowShape(value: unknown): boolean {
  if (!isRecord(value) || value.version !== 1) return false;
  return (
    Array.isArray(value.workspaces) &&
    value.workspaces.length > 0 &&
    value.workspaces.every(isPersistedWorkspaceShape) &&
    typeof value.activeWorkspaceId === 'string'
  );
}

/** Wrap a single `PersistedSession` as a one-Workspace `PersistedWindow`. */
export function wrapSessionInWindow(
  session: PersistedSession,
  id: WorkspaceId = DEFAULT_WORKSPACE_ID,
  name: string = DEFAULT_WORKSPACE_NAME,
): PersistedWindow {
  return { version: 1, workspaces: [{ id, name, session }], activeWorkspaceId: id };
}

/**
 * Read a persisted Window snapshot. Accepts a canonical `PersistedWindow`, a
 * JSON-stringified one, or a bare `PersistedSession` (any version) — the
 * pre-workspace shape — which migrates to a single Workspace named `Workspace 1`
 * (`docs/specs/transport.md`). Returns null when nothing usable is present.
 *
 * Each inner session is normalized/migrated through `readPersistedSession`. If
 * `activeWorkspaceId` does not match any Workspace, the first Workspace is made
 * active so the snapshot stays usable.
 */
export function readPersistedWindow(raw: unknown): PersistedWindow | null {
  const value = parseJsonString(raw);
  if (!isRecord(value)) return null;

  if (isPersistedWindowShape(value)) {
    const workspaces = (value.workspaces as PersistedWorkspace[])
      .map((ws) => {
        const session = readPersistedSession(ws.session);
        return session ? { id: ws.id, name: ws.name, session } : null;
      })
      .filter((ws): ws is PersistedWorkspace => ws !== null);
    if (workspaces.length === 0) return null;
    const activeWorkspaceId = workspaces.some((ws) => ws.id === value.activeWorkspaceId)
      ? (value.activeWorkspaceId as WorkspaceId)
      : workspaces[0].id;
    return { version: 1, workspaces, activeWorkspaceId };
  }

  // Pre-workspace bare PersistedSession → single-Workspace window.
  const session = readPersistedSession(value);
  return session ? wrapSessionInWindow(session) : null;
}

/** The active Workspace's session, or the first Workspace's as a fallback. */
export function activeWorkspaceSession(window: PersistedWindow): PersistedSession {
  const active = window.workspaces.find((ws) => ws.id === window.activeWorkspaceId);
  return (active ?? window.workspaces[0]).session;
}

/** Return a copy of the Window with the active Workspace's session replaced,
 *  preserving every other Workspace. */
export function replaceActiveSession(window: PersistedWindow, session: PersistedSession): PersistedWindow {
  return {
    ...window,
    workspaces: window.workspaces.map((ws) => (ws.id === window.activeWorkspaceId ? { ...ws, session } : ws)),
  };
}

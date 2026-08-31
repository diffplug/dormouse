import type { SessionStatus } from './alert-manager';
import { ACTIVITY_NOTIFICATION_SOURCES, type ActivityNotification, type TodoState } from './alert-manager';

/** Only TODO/detail restore; `status` is diagnostic and never resurrects a ring. */
export interface PersistedAlertState {
  status: SessionStatus;
  todo: TodoState;
  notification?: ActivityNotification | null;
}

/** Absent means terminal; browser panes rebuild from the persisted layout. */
export type PersistedSurfaceType = 'terminal' | 'browser' | 'tool';

/** Stable declaration/runtime identity needed to rebuild a tool after its PTY
 * is respawned. Derived browser state (URL/session/port conflict) never enters
 * this projection. */
export interface PersistedToolMetadata {
  name?: string;
  render: 'iframe' | 'ab-screencast';
  port: 'announced' | 'auto';
  key?: string[];
}

/** Durable pane structure, never scrollback. Single-use recovery commands travel
 * out of band through `PlatformAdapter.getRecoveryCommands`. */
export interface PersistedPane {
  id: string;
  cwd: string | null;
  title: string;
  untouched: boolean;
  alert?: PersistedAlertState | null;
  surfaceType?: PersistedSurfaceType;
  /** Tool-only command, re-run on cold restore. This is separate from the
   * host-owned, single-use agent recovery command. */
  command?: string;
  /** Tool-only stable metadata; browser state is re-derived after respawn. */
  tool?: PersistedToolMetadata;
}

/** Shared browser-pane projection for renderer saves and VS Code host refresh. */
export function browserPersistedPane(
  pane: { id: string; title: string },
  alert: PersistedAlertState | null,
): PersistedPane {
  return {
    id: pane.id,
    title: pane.title,
    cwd: null,
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
  /** Lath restore token (`RestoreToken`), written by every door so it restores
   *  at its captured tier (docs/specs/tiling-engine.md → "Restore tokens"). Typed
   *  `unknown` to keep this module free of the lath core dep. */
  token?: unknown;
}

/** Workspace-scoped stable `dor` short refs: Surface id -> `surface:N`. */
export type PersistedSurfaceRefs = Record<string, string>;

export interface PersistedSession {
  version: 3;
  panes: PersistedPane[];
  doors?: PersistedDoor[];
  /** Native Lath persisted layout (`LathPersistedLayout`) — the layout Dormouse
   *  writes (docs/specs/tiling-engine.md → "Persistence"). */
  lathLayout?: unknown;
  /** Stable `dor` short refs scoped to this Workspace. Refs are never reused. */
  surfaceRefs?: PersistedSurfaceRefs;
  /** Next `surface:N` number to hand out in this Workspace. Persisted alongside
   *  `surfaceRefs` (not derived from it) so a killed Surface's entry can be dropped
   *  from `surfaceRefs` immediately without its number ever being reused. */
  surfaceRefsNext?: number;
}

export type WorkspaceId = string;

/** A named Workspace inside a Window; its inner Session keeps independent versioning. */
export interface PersistedWorkspace {
  id: WorkspaceId;
  name: string;
  session: PersistedSession;
}

/** Standalone Window snapshot. VS Code persists one bare Session per webview. */
export interface PersistedWindow {
  version: 1;
  workspaces: PersistedWorkspace[];
  activeWorkspaceId: WorkspaceId;
}

/** Default id/name for the single Workspace a fresh Window is created with. */
export const DEFAULT_WORKSPACE_ID: WorkspaceId = 'workspace-1';
export const DEFAULT_WORKSPACE_NAME = 'Workspace 1';

type PersistedPaneInput = Omit<PersistedPane, 'untouched'> & { untouched?: boolean };

interface PersistedSessionV3Input {
  version: 3;
  panes: PersistedPaneInput[];
  doors?: PersistedDoor[];
  lathLayout?: unknown;
  surfaceRefs?: unknown;
  surfaceRefsNext?: unknown;
}

// --- Validation guards (reject untrusted blobs) ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function isPersistedAlertShape(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  if (typeof value.status !== 'string') return false;
  if (typeof value.todo !== 'boolean') return false;
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
    // Neither `scrollback` nor `resumeCommand` is checked: legacy blobs carry
    // them and stay readable, new ones never do, and `normalizeSessionV3` strips
    // both either way.
    (value.untouched === undefined || typeof value.untouched === 'boolean') &&
    (value.surfaceType === undefined || value.surfaceType === 'terminal' || value.surfaceType === 'browser' || value.surfaceType === 'tool') &&
    (value.command === undefined || (value.surfaceType === 'tool' && typeof value.command === 'string')) &&
    (value.tool === undefined || (value.surfaceType === 'tool' && isPersistedToolMetadataShape(value.tool))) &&
    (value.alert === undefined || isPersistedAlertShape(value.alert))
  );
}

function isPersistedToolMetadataShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.name === undefined || typeof value.name === 'string') &&
    (value.render === 'iframe' || value.render === 'ab-screencast') &&
    (value.port === 'announced' || value.port === 'auto') &&
    (value.key === undefined || (Array.isArray(value.key) && value.key.every((part) => typeof part === 'string')))
  );
}

function isPersistedDoor(value: unknown): value is PersistedDoor {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (value.component === undefined || typeof value.component === 'string') &&
    (value.tabComponent === undefined || typeof value.tabComponent === 'string') &&
    (value.params === undefined || isRecord(value.params)) &&
    // A Lath restore token, when present, is structurally an object with a string
    // `leafId` (kept permissive — the core owns full validation on restore).
    (value.token === undefined || (isRecord(value.token) && typeof value.token.leafId === 'string'))
  );
}

function isPersistedSessionV3(value: unknown): value is PersistedSessionV3Input {
  if (!isRecord(value) || value.version !== 3) return false;
  return (
    Array.isArray(value.panes) &&
    value.panes.every(isPersistedPaneShape) &&
    (value.doors === undefined || (Array.isArray(value.doors) && value.doors.every(isPersistedDoor)))
  );
}

function validSurfaceRef(value: unknown): value is string {
  return typeof value === 'string' && /^surface:[1-9]\d*$/.test(value);
}

function normalizeSurfaceRefs(value: unknown): PersistedSurfaceRefs | undefined {
  if (!isRecord(value)) return undefined;
  const refs: PersistedSurfaceRefs = {};
  for (const [id, ref] of Object.entries(value)) {
    if (id.length > 0 && validSurfaceRef(ref)) refs[id] = ref;
  }
  return Object.keys(refs).length > 0 ? refs : undefined;
}

function normalizeSurfaceRefsNext(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value) && value >= 1 ? value : undefined;
}

/** Carry the optional ref map and counter together through restore/resume shapes. */
export function carrySurfaceRefs(
  source: Pick<PersistedSession, 'surfaceRefs' | 'surfaceRefsNext'> | null | undefined,
): Pick<PersistedSession, 'surfaceRefs' | 'surfaceRefsNext'> {
  return {
    ...(source?.surfaceRefs ? { surfaceRefs: source.surfaceRefs } : {}),
    ...(source?.surfaceRefsNext !== undefined ? { surfaceRefsNext: source.surfaceRefsNext } : {}),
  };
}

/** Parse a v3 Session; malformed present state warns and falls back to fresh. */
export function readPersistedSession(raw: unknown): PersistedSession | null {
  if (isEmptyState(raw)) return null;
  const value = parseJsonString(raw);
  if (isPersistedSessionV3(value)) return normalizeSessionV3(value);
  console.warn('[dormouse] Ignoring unreadable persisted session; starting fresh.');
  return null;
}

function normalizeSessionV3(session: PersistedSessionV3Input): PersistedSession {
  const surfaceRefs = normalizeSurfaceRefs(session.surfaceRefs);
  const surfaceRefsNext = normalizeSurfaceRefsNext(session.surfaceRefsNext);
  const { surfaceRefs: _rawRefs, surfaceRefsNext: _rawNext, ...rest } = session;
  // Deny-list retired fields so future PersistedPane fields pass through without
  // manual allowlist updates. Neither retired field is on PersistedPaneInput.
  const panes: PersistedPane[] = session.panes.map((pane) => {
    const {
      scrollback: _retiredScrollback,
      resumeCommand: _retiredResumeCommand,
      ...carried
    } = pane as PersistedPaneInput & { scrollback?: unknown; resumeCommand?: unknown };
    return { ...carried, untouched: pane.untouched ?? false };
  });
  return {
    ...(rest as Omit<PersistedSession, 'panes' | 'surfaceRefs' | 'surfaceRefsNext'>),
    panes,
    ...carrySurfaceRefs({ surfaceRefs, surfaceRefsNext }),
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

/** No saved state at all (fresh install): null/undefined or an empty string. Not an
 *  error — the caller starts fresh without a warning. */
function isEmptyState(raw: unknown): boolean {
  return raw == null || (typeof raw === 'string' && raw.trim() === '');
}

// --- Window container (stage 2b) ---

// Structural gate only: a v1 Window with a workspaces array and an active id.
// Each Workspace element is validated (and dropped if bad) per-item in
// readPersistedWindow, so malformed elements don't reject the whole Window.
function isPersistedWindowShape(value: unknown): boolean {
  return (
    isRecord(value) &&
    value.version === 1 &&
    Array.isArray(value.workspaces) &&
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

/** Parse a Window, dropping invalid Workspaces and repairing a dangling active id. */
export function readPersistedWindow(raw: unknown): PersistedWindow | null {
  if (isEmptyState(raw)) return null;
  const value = parseJsonString(raw);
  if (!isRecord(value) || !isPersistedWindowShape(value)) {
    console.warn('[dormouse] Ignoring unreadable persisted window; starting fresh.');
    return null;
  }

  const workspaces = (value.workspaces as unknown[])
    .map((ws): PersistedWorkspace | null => {
      if (!isRecord(ws) || typeof ws.id !== 'string' || typeof ws.name !== 'string') return null;
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

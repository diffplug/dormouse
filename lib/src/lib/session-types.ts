import { normalizeAlertDeliveryOverrides, type AlertDeliveryOverrides } from './alert-delivery-model';
import { isRecord } from './is-record';
import { isToolKeyScope, isToolRender, type ToolKeyScope, type ToolRender } from './platform/tool-types';
import { isBrowserViewportSetting, type BrowserViewportSetting } from 'dor-lib-common/browser-viewports';
import type { SessionStatus } from './alert-manager';
import type { WorkspaceMeta } from './workspace-store';
import { isAlertDeferred, type AlertEpisode } from './alert-episode';
import { hasShellInputControls } from 'dor/commands/shell-quote';
import {
  ACTIVITY_NOTIFICATION_SOURCES,
  type ActivityNotification,
  type TodoState,
} from './alert-manager';

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
  /** Resolved arguments, re-quoted for the shell selected at cold restore. */
  argv?: string[];
  scope?: ToolKeyScope;
  name?: string;
  render: ToolRender;
  viewport?: BrowserViewportSetting;
  port: 'announced' | 'auto';
  key?: string[];
  /** The Workspace's preview slot mark (`docs/specs/dor-tool.md` -> Preview slot). */
  preview?: true;
  /** The canonical file an `open` gave this Tool. */
  target?: string;
  /** Stopped while idle: restored with no process, started when shown
   *  (`docs/specs/dor-tool.md` -> Reaping). */
  reaped?: true;
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

/**
 * Narrow Activity down to what may reach disk. The parameter deliberately uses
 * the persisted shape: live `AlertState` is structurally assignable to it, and
 * this explicit projection keeps `JSON.stringify` from writing extra live or
 * stale fields (`docs/specs/alert.md` -> Public State, "Persist only"). A ring
 * no one has looked at is written as the TODO a look would have left.
 */
export function toPersistedAlertState(state: PersistedAlertState & { episode?: AlertEpisode | null }): PersistedAlertState {
  return {
    status: state.status,
    todo: state.todo || state.status === 'ALERT_RINGING' || isAlertDeferred(state),
    notification: state.notification ?? null,
  };
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

/** The `PersistedSession.version` this build writes and the only one it reads
 *  (`docs/specs/transport.md` → "Persisted session types"). Pinned against the
 *  Rust host by `standalone/scripts/persisted-format.json`. */
export const PERSISTED_SESSION_VERSION = 4;
/** The `PersistedWindow.version` this build writes and the only one it reads. */
export const PERSISTED_WINDOW_VERSION = 2;

export interface PersistedSession {
  /** Workspace delivery overrides, shared by standalone and VS Code snapshots. */
  alertDelivery?: AlertDeliveryOverrides;
  version: typeof PERSISTED_SESSION_VERSION;
  panes: PersistedPane[];
  doors?: PersistedDoor[];
  /** Native Lath persisted layout (`LathPersistedLayout`) — the layout Dormouse
   *  writes (docs/specs/tiling-engine.md → "Persistence"). */
  lathLayout?: unknown;
}

export type WorkspaceId = string;

/** A named Workspace inside a Window; its inner Session keeps independent versioning. */
export interface PersistedWorkspace {
  id: WorkspaceId;
  name: string;
  nameIsAuto: boolean;
  /** Written only when true; absent reads as unpinned
   *  (`docs/specs/layout.md` → "Workspace tabs"). */
  pinned?: true;
  session: PersistedSession;
}

/** A Workspace's persisted record: its identity and naming, `pinned` only when
 *  set, and its session. Every record a Window builds goes through this. */
export function workspaceRecord(
  meta: { id: WorkspaceId; name: string; nameIsAuto: boolean; pinned?: boolean },
  session: PersistedSession,
): PersistedWorkspace {
  return { id: meta.id, name: meta.name, nameIsAuto: meta.nameIsAuto, ...(meta.pinned ? { pinned: true } : {}), session };
}

/** The store's model of a persisted record: the inverse of `workspaceRecord`,
 *  its delivery overrides read back out of the session. */
export function metaFromRecord(record: PersistedWorkspace): WorkspaceMeta {
  const { id, name, nameIsAuto, pinned, session } = record;
  return {
    id, name, nameIsAuto,
    ...(pinned ? { pinned } : {}),
    ...(session.alertDelivery ? { alertDelivery: session.alertDelivery } : {}),
  };
}

/** Standalone Window snapshot. VS Code persists one bare Session per webview. */
export interface PersistedWindow {
  version: typeof PERSISTED_WINDOW_VERSION;
  workspaces: PersistedWorkspace[];
  activeWorkspaceId: WorkspaceId;
  /** A closed window's snapshot, kept for Reopen with that window's ids: the
   *  window that boots from it remaps them before restoring
   *  (`withFreshWindowIds` in `lib/src/components/wall/window-reopen.ts`). */
  reopened?: true;
}

/** Default id/name for the single Workspace a fresh Window is created with. */
export const DEFAULT_WORKSPACE_ID: WorkspaceId = 'workspace:1';
export const DEFAULT_WORKSPACE_NAME = 'Workspace 1';

type PersistedSessionInput = Omit<PersistedSession, 'alertDelivery'> & { alertDelivery?: unknown };

// --- Validation guards (reject untrusted blobs) ---

// `status` is diagnostic and `notification` optional detail: an unknown value
// of either — a newer build's — never rejects the pane (`normalizePersistedAlert`).
function isPersistedAlertShape(value: unknown): boolean {
  if (value === null) return true;
  if (!isRecord(value)) return false;
  return typeof value.status === 'string' && typeof value.todo === 'boolean';
}

/** Read a notification this build cannot validate as none, keeping the TODO. */
function normalizePersistedAlert(alert: PersistedAlertState): PersistedAlertState {
  const notification: unknown = alert.notification;
  if (notification === undefined || notification === null || isActivityNotificationShape(notification)) return alert;
  return { ...alert, notification: null };
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
    typeof value.untouched === 'boolean' &&
    (value.surfaceType === undefined || value.surfaceType === 'terminal' || value.surfaceType === 'browser' || value.surfaceType === 'tool') &&
    (value.command === undefined || (value.surfaceType === 'tool' && typeof value.command === 'string')) &&
    (value.tool === undefined || (value.surfaceType === 'tool' && isPersistedToolMetadataShape(value.tool))) &&
    (value.alert === undefined || isPersistedAlertShape(value.alert))
  );
}

function isPersistedToolMetadataShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    (value.argv === undefined || isToolCommandArgv(value.argv)) &&
    (value.name === undefined || typeof value.name === 'string') &&
    (value.scope === undefined || isToolKeyScope(value.scope)) &&
    isToolRender(value.render) &&
    (value.viewport === undefined || isBrowserViewportSetting(value.viewport)) &&
    (value.port === 'announced' || value.port === 'auto') &&
    (value.key === undefined || (Array.isArray(value.key) && value.key.every((part) => typeof part === 'string'))) &&
    (value.preview === undefined || value.preview === true) &&
    (value.target === undefined || (typeof value.target === 'string' && !hasShellInputControls(value.target))) &&
    (value.reaped === undefined || value.reaped === true)
  );
}

/** Typed into a terminal after quoting: controls cannot be made safe by quotes. */
export function isToolCommandArgv(value: unknown): value is string[] {
  return Array.isArray(value) && value.length > 0
    && value.every(arg => typeof arg === 'string' && !hasShellInputControls(arg))
    && value[0].trim().length > 0;
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

function isPersistedSession(value: unknown): value is PersistedSessionInput {
  if (!isRecord(value) || value.version !== PERSISTED_SESSION_VERSION) return false;
  return (
    Array.isArray(value.panes) &&
    value.panes.every(isPersistedPaneShape) &&
    (value.doors === undefined || (Array.isArray(value.doors) && value.doors.every(isPersistedDoor)))
  );
}

/** Parse a Session; another build's version is a quiet fresh start, malformed
 *  present state warns and falls back to fresh. */
export function readPersistedSession(raw: unknown): PersistedSession | null {
  if (isEmptyState(raw)) return null;
  const value = parseJsonString(raw);
  if (isPersistedSession(value)) return normalizeSession(value);
  logDiscard(value, PERSISTED_SESSION_VERSION, 'session');
  return null;
}

/** Say why a present blob starts fresh: another build's version is expected
 *  and never migrated (`docs/specs/transport.md` → "Persisted session types");
 *  anything else is unreadable. */
function logDiscard(value: unknown, current: number, kind: 'session' | 'window'): void {
  const version = isRecord(value) ? value.version : undefined;
  if (typeof version === 'number' && version !== current) {
    console.info(`[dormouse] Discarding a ${kind} saved by another version (format ${version}); starting fresh.`);
  } else {
    console.warn(`[dormouse] Ignoring unreadable persisted ${kind}; starting fresh.`);
  }
}

function normalizeSession(session: PersistedSessionInput): PersistedSession {
  const alertDelivery = normalizeAlertDeliveryOverrides(session.alertDelivery);
  const { alertDelivery: _rawDelivery, ...rest } = session;
  const panes = session.panes.map((pane) => pane.alert ? { ...pane, alert: normalizePersistedAlert(pane.alert) } : pane);
  return {
    ...rest,
    panes,
    ...(Object.keys(alertDelivery).length ? { alertDelivery } : {}),
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

// Structural gate only: a current Window with a workspaces array and an active id.
// Each Workspace element is validated (and dropped if bad) per-item in
// readPersistedWindow, so malformed elements don't reject the whole Window.
function isPersistedWindowShape(value: unknown): value is Record<string, unknown> {
  return (
    isRecord(value) &&
    value.version === PERSISTED_WINDOW_VERSION &&
    Array.isArray(value.workspaces) &&
    typeof value.activeWorkspaceId === 'string'
  );
}

// `pinned` and `session` are read leniently: anything but `true` is unpinned,
// and the session goes through `readPersistedSession`.
function isPersistedWorkspaceShape(value: unknown): value is Record<string, unknown> & Pick<PersistedWorkspace, 'id' | 'name' | 'nameIsAuto'> {
  return isRecord(value) && typeof value.id === 'string' && typeof value.name === 'string' && typeof value.nameIsAuto === 'boolean';
}

/** Parse a Window, dropping invalid Workspaces and repairing a dangling active id. */
export function readPersistedWindow(raw: unknown): PersistedWindow | null {
  if (isEmptyState(raw)) return null;
  const value = parseJsonString(raw);
  if (!isPersistedWindowShape(value)) {
    logDiscard(value, PERSISTED_WINDOW_VERSION, 'window');
    return null;
  }

  const seen = new Set<WorkspaceId>();
  const workspaces = (value.workspaces as unknown[])
    .map((ws): PersistedWorkspace | null => {
      if (!isPersistedWorkspaceShape(ws)) {
        console.warn('[dormouse] Ignoring a malformed persisted Workspace');
        return null;
      }
      // First wins. A duplicate id is rejected outright by `setWorkspaces`, and a
      // blob that throws there would leave the app with nothing rendered at all.
      if (seen.has(ws.id)) {
        console.warn(`[dormouse] Ignoring a duplicate persisted Workspace id: ${ws.id}`);
        return null;
      }
      const session = readPersistedSession(ws.session);
      if (!session) return null;
      seen.add(ws.id);
      return workspaceRecord({ id: ws.id, name: ws.name, nameIsAuto: ws.nameIsAuto, pinned: ws.pinned === true }, session);
    })
    .filter((ws): ws is PersistedWorkspace => ws !== null);
  if (workspaces.length === 0) return null;
  const activeWorkspaceId = workspaces.some((ws) => ws.id === value.activeWorkspaceId)
    ? (value.activeWorkspaceId as WorkspaceId)
    : workspaces[0].id;
  return { version: PERSISTED_WINDOW_VERSION, workspaces, activeWorkspaceId, ...(value.reopened === true ? { reopened: true } : {}) };
}

/** Every pane id the Window's Workspaces name, across all of them — what a boot
 *  claims its recovery record against. */
export function windowPaneIds(window: PersistedWindow | null): string[] {
  return window?.workspaces.flatMap((workspace) => workspace.session.panes.map((pane) => pane.id)) ?? [];
}

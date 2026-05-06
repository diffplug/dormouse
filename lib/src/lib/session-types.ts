import type { DoorDirection } from './spatial-nav';
import type { SessionStatus } from './activity-monitor';
import { migrateTodoState, type TodoState } from './alert-manager';

export interface PersistedAlertState {
  status: SessionStatus;
  todo: TodoState;
}

export interface PersistedPane {
  id: string;
  cwd: string | null;
  title: string;
  scrollback: string | null;
  resumeCommand: string | null;
  alert?: PersistedAlertState | null;
}

export interface PersistedDoor {
  id: string;
  title: string;
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
  const t = value.todo;
  return typeof t === 'boolean' || typeof t === 'number' || typeof t === 'string';
}

function isPersistedPaneShape(value: unknown): boolean {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'string' &&
    typeof value.title === 'string' &&
    (typeof value.cwd === 'string' || value.cwd === null) &&
    (typeof value.scrollback === 'string' || value.scrollback === null) &&
    (typeof value.resumeCommand === 'string' || value.resumeCommand === null) &&
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

function isPersistedSessionV3(value: unknown): value is PersistedSession {
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
      alert: pane.alert
        ? { status: pane.alert.status, todo: migrateTodoState(pane.alert.todo) }
        : pane.alert,
    })),
  };
}

export function readPersistedSession(raw: unknown): PersistedSession | null {
  const value = parseJsonString(raw);
  if (!isRecord(value)) return null;
  if (isPersistedSessionV3(value)) return value;
  if (isPersistedSessionV2(value)) return migrateSessionV2toV3(value);
  if (isPersistedSessionV1(value)) return migrateSessionV2toV3(migrateSessionV1toV2(value));
  return null;
}

function parseJsonString(raw: unknown): unknown {
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

import type { SessionStatus } from './activity-monitor';
import { ACTIVITY_NOTIFICATION_SOURCES, type ActivityNotification, type TodoState } from './alert-manager';

/**
 * Only the TODO reminder and its notification detail survive a restart.
 * WATCHING is not persisted per Session — it is derived from the global rule
 * set keyed on the running command (`docs/specs/alert.md`). `status` is written
 * for diagnostics and older readers; restore never resurrects a ring from it.
 */
export interface PersistedAlertState {
  status: SessionStatus;
  todo: TodoState;
  notification?: ActivityNotification | null;
}

/**
 * Surface kind recorded per pane (`docs/specs/glossary.md`). Absent reads as
 * `'terminal'`. A `'browser'` pane has no PTY or registry entry; it
 * is reconstructed from the persisted layout, so restore/resume must route it
 * differently from a terminal (see `session-restore.ts`, `reconnect.ts`).
 */
export type PersistedSurfaceType = 'terminal' | 'browser';

/**
 * Durable structure for one pane — furniture, never content. Scrollback is
 * deliberately absent: it is not persisted by any writer (docs/specs/transport.md
 * -> "What is persisted"). `resumeCommand` is the single recovery field, written
 * only by a host teardown that interrupted a running agent, and consumed by the
 * next cold restore.
 */
export interface PersistedPane {
  id: string;
  cwd: string | null;
  title: string;
  resumeCommand: string | null;
  untouched: boolean;
  alert?: PersistedAlertState | null;
  surfaceType?: PersistedSurfaceType;
}

/**
 * Build the persisted record for a browser surface. Browser panes have no PTY,
 * so the terminal-only fields (cwd/resumeCommand/untouched) are always
 * blank; the persisted layout reconstructs the surface and `alert` carries the
 * optional TODO. Single source of truth shared by the renderer save path
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
    // `scrollback` is not checked at all: legacy blobs carry one and are still
    // readable, new ones never do. `normalizeSessionV3` strips it either way.
    (value.resumeCommand === undefined || typeof value.resumeCommand === 'string' || value.resumeCommand === null) &&
    (value.untouched === undefined || typeof value.untouched === 'boolean') &&
    (value.surfaceType === undefined || value.surfaceType === 'terminal' || value.surfaceType === 'browser') &&
    (value.alert === undefined || isPersistedAlertShape(value.alert))
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

/** The conditional-spread of the surface-ref registry fields (`surfaceRefs` +
 *  its `surfaceRefsNext` counter), so a restored `PersistedSession`'s refs thread
 *  through `RestoredSession` / `ReconnectResult` without each carry site repeating
 *  the pair of presence checks. */
export function carrySurfaceRefs(
  source: Pick<PersistedSession, 'surfaceRefs' | 'surfaceRefsNext'> | null | undefined,
): Pick<PersistedSession, 'surfaceRefs' | 'surfaceRefsNext'> {
  return {
    ...(source?.surfaceRefs ? { surfaceRefs: source.surfaceRefs } : {}),
    ...(source?.surfaceRefsNext !== undefined ? { surfaceRefsNext: source.surfaceRefsNext } : {}),
  };
}

/**
 * Stamp `resumeCommand` onto the panes a host captured one for, leaving every
 * other pane and every other field untouched. Returns the ids that actually
 * landed on a pane — a captured id whose pane is gone must not be reported as
 * applied. Shared by both consumers of a recovery record: the in-webview overlay
 * (`withRecoveryCommands`) and the VS Code host's cold-restore read.
 */
export function applyRecoveryCommands(
  session: PersistedSession,
  commands: ReadonlyMap<string, string> | Readonly<Record<string, string>>,
): { session: PersistedSession; applied: string[] } {
  const lookup = commands instanceof Map ? commands : new Map(Object.entries(commands));
  const applied: string[] = [];
  const panes = session.panes.map((pane) => {
    const command = lookup.get(pane.id);
    if (!command) return pane;
    applied.push(pane.id);
    return { ...pane, resumeCommand: command };
  });
  return { session: { ...session, panes }, applied };
}

/**
 * Overlay host-captured recovery commands onto a webview-owned snapshot.
 *
 * `resumeCommand` is the one persisted field the **host** owns exclusively: only a
 * teardown that interrupted a running agent writes one, and the webview's own copy
 * is always a carry-forward of whatever it last saw — which is `null`, because its
 * final save happens before the interrupt. A host whose state read prefers the
 * webview copy (VS Code persists it across a window reload) would therefore drop
 * every captured command on exactly the boundary the field exists for.
 *
 * Layout, cwd, titles and alert state still come from the webview copy, which is
 * fresher for everything the webview actually owns.
 */
export function withRecoveryCommands(webviewState: unknown, hostState: unknown): unknown {
  const host = readPersistedSession(hostState);
  if (!host) return webviewState;
  const commands = new Map(
    host.panes.filter((pane) => pane.resumeCommand).map((pane) => [pane.id, pane.resumeCommand!]),
  );
  if (commands.size === 0) return webviewState;
  const webview = readPersistedSession(webviewState);
  // No usable webview copy at all — the host snapshot is all there is.
  if (!webview) return hostState;
  return applyRecoveryCommands(webview, commands).session;
}

/**
 * Parse a persisted session blob (`version: 3`), or null if nothing usable is
 * present. A blob that is absent/empty returns null silently; one that is present
 * but unreadable (bad JSON, wrong shape) is logged and discarded so a corrupt save
 * can never block startup — the caller starts fresh (`docs/specs/transport.md`).
 */
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
  // Every pane is rebuilt field by field rather than spread, so a transcript in a
  // pre-upgrade blob is dropped here and cannot survive into a parsed Session —
  // the one place that guarantees no reader hands one to a writer
  // (docs/specs/transport.md -> "Retiring the transcripts already on disk").
  const panes: PersistedPane[] = session.panes.map((pane) => {
    const next: PersistedPane = {
      id: pane.id,
      cwd: pane.cwd,
      title: pane.title,
      resumeCommand: pane.resumeCommand ?? null,
      untouched: pane.untouched ?? false,
    };
    if (pane.alert !== undefined) next.alert = pane.alert;
    if (pane.surfaceType !== undefined) next.surfaceType = pane.surfaceType;
    return next;
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

/**
 * Read a persisted Window snapshot (a canonical `PersistedWindow` or a
 * JSON-stringified one). Returns null when nothing usable is present — an
 * absent/empty blob silently, a present-but-unreadable one with a warning so a
 * corrupt save can never block startup (`docs/specs/transport.md`).
 *
 * Each inner session is validated through `readPersistedSession`; Workspaces whose
 * session is unreadable are dropped. If `activeWorkspaceId` does not match any
 * Workspace, the first Workspace is made active so the snapshot stays usable.
 */
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

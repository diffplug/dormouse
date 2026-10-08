/**
 * The dor control protocol's wire contract — shared by the CLI, the control
 * servers that bridge it into each host, and the webview that fulfils control
 * requests. This is the single source of truth for the transport envelope;
 * method-specific request/response shapes live in `commands/types.ts`. As the
 * protocol grows, add to these types here rather than re-declaring them per
 * layer.
 */

/**
 * The wire identifier for each surface control operation. Single source of truth
 * shared by the CLI client (which emits them) and the webview handler (which
 * dispatches on them) — reference these instead of bare `'surface.*'` literals so
 * the two sides can't drift and a typo is a compile error, not a silent no-op.
 */
export const SURFACE_CONTROL_METHODS = {
  list: 'surface.list',
  split: 'surface.split',
  ensure: 'surface.ensure',
  tool: 'surface.tool',
  send: 'surface.send',
  read: 'surface.read',
  await: 'surface.await',
  kill: 'surface.kill',
  move: 'surface.move',
  iframe: 'surface.iframe',
  browser: 'surface.browser',
  browserViewport: 'surface.browserViewport',
  resolveBrowser: 'surface.resolveBrowser',
  resolveOpen: 'surface.resolveOpen',
} as const;

export type SurfaceControlMethod = (typeof SURFACE_CONTROL_METHODS)[keyof typeof SURFACE_CONTROL_METHODS];

/**
 * The wire identifier for each Workspace control operation, enumerated here
 * beside the Surface methods for the same reason. These are container verbs, so
 * the window-level router answers them itself rather than handing them to a Wall
 * (`docs/specs/dor-cli.md` → "dor workspace").
 */
export const WORKSPACE_CONTROL_METHODS = {
  list: 'workspace.list',
  new: 'workspace.new',
  rename: 'workspace.rename',
  close: 'workspace.close',
  switch: 'workspace.switch',
  move: 'workspace.move',
  pin: 'workspace.pin',
} as const;

export type WorkspaceControlMethod = (typeof WORKSPACE_CONTROL_METHODS)[keyof typeof WORKSPACE_CONTROL_METHODS];

/**
 * The wire identifier for each app control operation — verbs on the running
 * app itself (`docs/specs/dor-cli.md` → "dor app").
 */
export const APP_CONTROL_METHODS = {
  restart: 'app.restart',
} as const;

export type AppControlMethod = (typeof APP_CONTROL_METHODS)[keyof typeof APP_CONTROL_METHODS];

/**
 * The wire identifier for each Window control operation — verbs on the Window
 * the request lands in, whichever Workspace is active
 * (`docs/specs/dor-cli.md` → "dor reopen").
 */
export const WINDOW_CONTROL_METHODS = {
  reopen: 'window.reopen',
} as const;

export type WindowControlMethod = (typeof WINDOW_CONTROL_METHODS)[keyof typeof WINDOW_CONTROL_METHODS];

/**
 * The wire identifier for each read of the Tool configuration
 * (`docs/specs/dor-tool.md` → CLI). Launching a Tool places a Surface, so it
 * is `surface.tool` instead.
 */
export const TOOL_CONTROL_METHODS = {
  list: 'tool.list',
  openHandlers: 'tool.openHandlers',
} as const;

export type ToolControlMethod = (typeof TOOL_CONTROL_METHODS)[keyof typeof TOOL_CONTROL_METHODS];

/**
 * Short names for `dor` verbs: `dor o` is `dor open`. The takeover gate reads
 * a typed command line, so it resolves these as the CLI does
 * (`docs/specs/dor-tool.md` -> Take-over).
 */
const DOR_VERB_ALIASES: Readonly<Record<string, string>> = { o: 'open' };

/** The verb a typed `dor` command line names, its alias resolved. */
export function canonicalDorVerb(verb: string): string {
  return Object.prototype.hasOwnProperty.call(DOR_VERB_ALIASES, verb) ? DOR_VERB_ALIASES[verb] : verb;
}

/** Every method the control channel carries. */
export type DorControlMethod = SurfaceControlMethod | WorkspaceControlMethod | AppControlMethod | WindowControlMethod | ToolControlMethod;

const WORKSPACE_METHOD_SET: ReadonlySet<string> = new Set(Object.values(WORKSPACE_CONTROL_METHODS));
const APP_METHOD_SET: ReadonlySet<string> = new Set(Object.values(APP_CONTROL_METHODS));
const TOOL_METHOD_SET: ReadonlySet<string> = new Set(Object.values(TOOL_CONTROL_METHODS));
const WINDOW_METHOD_SET: ReadonlySet<string> = new Set(Object.values(WINDOW_CONTROL_METHODS));

/**
 * A host's refusal of a method it does not know. **Frozen text:** a newer `dor`
 * recognizes an older host by it (`docs/specs/dor-cli.md` → "dor app").
 */
export function unsupportedControlMethodMessage(method: string): string {
  return `unsupported Dormouse control method '${method}'`;
}

/** Whether this method acts on the running app rather than on any Workspace. */
export function isAppControlMethod(method: string): method is AppControlMethod {
  return APP_METHOD_SET.has(method);
}

/** Whether this method acts on the Window rather than on one Workspace. */
export function isWindowControlMethod(method: string): method is WindowControlMethod {
  return WINDOW_METHOD_SET.has(method);
}

/** Whether this method reads the Tool configuration rather than any Workspace. */
export function isToolControlMethod(method: string): method is ToolControlMethod {
  return TOOL_METHOD_SET.has(method);
}

/** Whether this method is a container verb — answered by the Window rather than
 *  by one Workspace's Wall. */
export function isWorkspaceControlMethod(method: string): method is WorkspaceControlMethod {
  return WORKSPACE_METHOD_SET.has(method);
}

/**
 * Whether this request reaches beyond a single Workspace: a container verb, or
 * the `scope: 'all'` listing. A host that cannot answer for more than one
 * Workspace refuses exactly these (`docs/specs/vscode.md` → "Workspaces").
 */
export function spansWorkspaces(method: string, params?: Record<string, unknown>): boolean {
  return method === SURFACE_CONTROL_METHODS.move || isWorkspaceControlMethod(method)
    || (method === SURFACE_CONTROL_METHODS.list && params?.scope === 'all');
}

/** The two readings of a `workspace:<n|name>` target (`docs/specs/dor-cli.md` →
 *  "Handle Model"). Both spellings are accepted bare. */
export interface ParsedWorkspaceRef {
  /** The target as written, trimmed — what an error message quotes back. */
  target: string;
  /** The number the ref reads as, else null. What that number *means* is the
   *  resolving host's business: a registry host matches it against the
   *  Workspace's minted id, a host without one falls back to the strip
   *  position. Named for the reading, not for either resolution. */
  number: number | null;
  /** The Workspace name it reads as otherwise; empty when it is numeric. */
  name: string;
}

const NUMERIC_WORKSPACE_REF = /^[1-9]\d*$/;

/** Split a `workspace:<n|name>` target into its readings. A ref that reads as a
 *  number is a number, never a name. */
export function parseWorkspaceRef(ref: string): ParsedWorkspaceRef {
  const target = ref.trim();
  const bare = (target.startsWith('workspace:') ? target.slice('workspace:'.length) : target).trim();
  const numeric = NUMERIC_WORKSPACE_REF.test(bare);
  return { target, number: numeric ? Number(bare) : null, name: numeric ? '' : bare };
}

const SURFACE_ID_PREFIX = 'surface-';
const SURFACE_REF_PREFIX = 'surface:';
const BARE_NUMBER = /^\d+$/;

/** The number in a counter-minted `<prefix><n>` id, else null. */
function idNumber(prefix: string, id: string): number | null {
  const digits = id.startsWith(prefix) ? id.slice(prefix.length) : '';
  return BARE_NUMBER.test(digits) ? Number(digits) : null;
}

/** The registry number of a `workspace-<n>` id; a random or bare id has none. */
export function workspaceIdNumber(id: string): number | null {
  return idNumber('workspace-', id);
}

/** The Surface id numbered `n`. */
export function surfaceIdFor(n: number): string {
  return SURFACE_ID_PREFIX + n;
}

/** A Surface's `dor` ref, derived from its id: `surface-347` is `surface:347`
 *  (`docs/specs/dor-cli.md` → "Handle Model"). An id without the `surface-`
 *  prefix is its own ref. */
export function surfaceRefForId(id: string): string {
  return id.startsWith(SURFACE_ID_PREFIX) ? SURFACE_REF_PREFIX + id.slice(SURFACE_ID_PREFIX.length) : id;
}

/** The number in a `surface-<n>` id, else null. */
export function surfaceIdNumber(id: string): number | null {
  return idNumber(SURFACE_ID_PREFIX, id);
}

/** The highest `surface-<n>` number among `ids`, else 0. */
export function maxSurfaceIdNumber(ids: Iterable<string>): number {
  let max = 0;
  for (const id of ids) max = Math.max(max, surfaceIdNumber(id) ?? 0);
  return max;
}

/** Creation order: numbered ids by number, then every other id, ties by id. */
export function compareSurfaceIds(a: string, b: string): number {
  const na = surfaceIdNumber(a);
  const nb = surfaceIdNumber(b);
  if (na !== nb) {
    if (na === null) return 1;
    if (nb === null) return -1;
    return na - nb;
  }
  return a < b ? -1 : a > b ? 1 : 0;
}

/** What a `dor` Surface target names (`docs/specs/dor-cli.md` → "Handle
 *  Model"). `id` names one Surface Window-wide; `invalid` names none, and
 *  carries the refusal that says which form to use. */
export type ParsedSurfaceTarget =
  | { kind: 'title'; title: string }
  | { kind: 'self' }
  | { kind: 'focused' }
  | { kind: 'id'; id: string }
  | { kind: 'invalid'; message: string };

function notASurfaceHandle(target: string, n: string): ParsedSurfaceTarget {
  const suggestion = BARE_NUMBER.test(n) ? `${SURFACE_REF_PREFIX}${n}` : `${SURFACE_REF_PREFIX}<n>`;
  return { kind: 'invalid', message: `'${target}' is not a Surface handle; use ${suggestion}` };
}

/** Read a Surface target in the one grammar every host resolves. */
export function parseSurfaceTarget(target: string): ParsedSurfaceTarget {
  if (target.startsWith('title:')) return { kind: 'title', title: target.slice('title:'.length) };
  if (target === 'surface:focused') return { kind: 'focused' };
  if (target === 'surface:self') return { kind: 'self' };
  if (target.startsWith(SURFACE_REF_PREFIX)) {
    const rest = target.slice(SURFACE_REF_PREFIX.length);
    return rest ? { kind: 'id', id: SURFACE_ID_PREFIX + rest } : notASurfaceHandle(target, '');
  }
  if (BARE_NUMBER.test(target)) return notASurfaceHandle(target, target);
  if (target.startsWith('pane:')) return notASurfaceHandle(target, target.slice('pane:'.length));
  return { kind: 'id', id: target };
}

/** A control request as it travels over a transport, correlated by `requestId`. */
export interface DorControlRequestPayload {
  requestId: string;
  surfaceId?: string;
  /** Host-derived helper origin, captured before cross-window routing. Never
   *  accepted from the socket client; does not change the caller's identity. */
  helperParentId?: string;
  method: string;
  params?: Record<string, unknown>;
  /**
   * The client's own deadline for this request, in milliseconds. A hint, not an
   * instruction: the control server uses it to set a timer that deliberately
   * *outlasts* the client's, so the client is always the side that decides the
   * outcome. Absent (or nonsense) means "use the server's default".
   */
  timeoutMs?: number;
}

/**
 * Sent server → webview when a request will never be answered: the `dor` client
 * disconnected (timeout / Ctrl-C), or the server's own deadline fired. The
 * webview aborts the request's `AbortSignal` so a long-running handler can
 * release whatever it armed. Travels as the `dor:controlCancel` event, the
 * cancellation counterpart of `dor:controlRequest` / `dor:controlResponse`.
 */
export interface DorControlCancelPayload {
  requestId: string;
}

/** The result envelope returned for a control request. `result` is method-specific. */
export interface DorControlResult<T = unknown> {
  ok: boolean;
  result?: T;
  error?: string;
}

/** A control result correlated back to its request over a transport. */
export interface DorControlResponsePayload<T = unknown> extends DorControlResult<T> {
  requestId: string;
}

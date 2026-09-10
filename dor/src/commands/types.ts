import type {
  Command as StricliCommand,
  CommandContext,
  StricliProcess,
} from '@stricli/core';

export type IdFormat = 'refs' | 'ids' | 'both';
export type SplitDirection = 'left' | 'right' | 'up' | 'down' | 'auto';
export type ResolvedSplitDirection = 'left' | 'right' | 'up' | 'down';
export type SurfaceKind = 'terminal' | 'browser';
export type SurfaceRenderMode = 'iframe' | 'ab-screencast' | 'ab-popout';

/** What each kind is backed by (`docs/specs/glossary.md` → Panes and Surfaces).
 *  The single source of capability gating; kind switches elsewhere go through
 *  the predicates below. `Record<SurfaceKind, ...>` on purpose: adding a kind
 *  (the staged `tool`, which has both) must be a compile error here, not a
 *  silent `false`. */
const KIND_CAPABILITIES: Record<SurfaceKind, { terminal: boolean; browser: boolean }> = {
  terminal: { terminal: true, browser: false },
  browser: { terminal: false, browser: true },
};

/** Every kind, derived from the table so `--kind` parsing and its help
 *  placeholder cannot drift from it. */
export const SURFACE_KINDS = Object.keys(KIND_CAPABILITIES) as SurfaceKind[];

/** Whether this kind has a terminal — PTY-backed: `read` / `send` / `await` /
 *  port scans. */
export function hasTerminal(kind: SurfaceKind): boolean {
  return KIND_CAPABILITIES[kind].terminal;
}

/** Whether this kind has a browser renderer — nav / render-mode /
 *  agent-browser operations. */
export function hasBrowser(kind: SurfaceKind): boolean {
  return KIND_CAPABILITIES[kind].browser;
}

/** Where a Surface renders. Minimized Surfaces (baseboard doors) are listed too;
 *  `hidden` is reserved for Surfaces in an inactive Workspace (a future). */
export type SurfaceView = 'paned' | 'zoomed' | 'minimized' | 'hidden';

/** Shell activity of a terminal Surface (`docs/specs/terminal-state.md`). */
export type SurfaceActivity = 'unknown' | 'prompt' | 'editing' | 'running' | 'finished';

/** A listening TCP port opened by a terminal Surface's shell or a descendant
 *  process. `address` is the bind interface — `0.0.0.0` / `::` mean all
 *  interfaces, `127.0.0.1` / `::1` mean loopback-only. */
export interface SurfacePort {
  family: 'IPv4' | 'IPv6';
  address: string;
  port: number;
  pid: number;
  processName?: string;
}

export interface Surface {
  id: string;
  ref: string;
  kind: SurfaceKind;
  renderMode: SurfaceRenderMode | null;
  title: string;
  focused: boolean;
  /** Where the Surface renders; minimized Surfaces are listed with `minimized`. */
  view: SurfaceView;
  /** Reported working directory (terminal Surfaces); `null` for browser Surfaces. */
  cwd: string | null;
  /** Shell activity (terminal Surfaces); `null` for browser Surfaces. */
  activity: SurfaceActivity | null;
  /** Exit code of the most recently finished command, when known. */
  exitCode?: number;
  /** Running command label; `null` when idle or not a terminal Surface. */
  command: string | null;
  /** Target URL of a browser Surface; `null` for terminal Surfaces. */
  url: string | null;
  /** An alert is ringing. Browser Surfaces never ring. */
  ringing: boolean;
  /** User-flagged TODO. */
  todo: boolean;
  /** At least one `dor await` is parked on this Surface. Never persisted — a
   *  wait cannot outlive the process blocking on it. */
  awaited: boolean;
  /** Listening ports opened by this terminal Surface. Present only when the
   *  request set `includePorts` (`dor list --ports`); never on browser Surfaces. */
  ports?: SurfacePort[];
  /** The Workspace this Surface belongs to. Present only for a `scope: 'all'`
   *  listing, where rows from several Workspaces share one list. */
  workspaceRef?: string;
}

/** How wide a listing reaches: one Workspace (the default) or every Workspace
 *  in this Window. */
export type ListScope = 'workspace' | 'all';

export interface ListSurfacesRequest {
  pane?: string;
  workspace?: string;
  window?: string;
  /** Omitted means `workspace`. */
  scope?: ListScope;
  /** Enumerate each terminal Surface's listening ports. The host shells out per
   *  pane (lsof / PowerShell), so callers opt in; remote sessions report none. */
  includePorts?: boolean;
}

export interface ListSurfacesResponse {
  surfaces: Surface[];
  /** The Workspace that answered; for `scope: 'all'`, the one the request
   *  landed in. */
  workspaceRef: string;
  windowRef: string;
  /** Present only for `scope: 'all'`: this Window's Workspaces in strip order,
   *  so the caller can render a header for each group of `surfaces`. */
  workspaces?: WorkspaceRow[];
}

/** One Workspace of this Window, as `dor list --workspaces` prints it: its
 *  positional ref and name, whether it is the active one, and the union status
 *  over its member Surfaces (`docs/specs/alert.md` → Workspace union). */
export interface WorkspaceRow {
  ref: string;
  id: string;
  name: string;
  active: boolean;
  ringing: boolean;
  todo: boolean;
  /** Member Surfaces owing attention (ringing or TODO); each counts once. */
  count: number;
}

export interface ListWorkspacesRequest {
  window?: string;
}

export interface ListWorkspacesResponse {
  workspaces: WorkspaceRow[];
  windowRef: string;
}

export interface NewWorkspaceRequest {
  /** Defaults host-side to the next `Workspace N`. */
  name?: string;
  window?: string;
}

export interface RenameWorkspaceRequest {
  workspace: string;
  name: string;
  window?: string;
}

export interface CloseWorkspaceRequest {
  workspace: string;
  /** Close even though the Workspace holds touched or running Surfaces. */
  force: boolean;
  window?: string;
}

export interface SwitchWorkspaceRequest {
  workspace: string;
  window?: string;
}

/** The answer every mutating Workspace verb gives: what it did, and the
 *  Workspace it did it to. `workspaceRef` is positional, so for `close` it is
 *  the ref the Workspace had. */
export interface WorkspaceMutationResponse {
  status: 'created' | 'renamed' | 'closed' | 'active';
  workspaceId: string;
  workspaceRef: string;
  name: string;
}

export interface SplitSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  /** Raw argv for the initial command; the host quotes it for the target shell. */
  command?: string[];
  direction: SplitDirection;
  minimized: boolean;
  surface?: string;
  /** Leave focus on the caller instead of moving it to the new surface. The CLI
   *  sets it for every split except a bare `dor split` (no `--`, no command): a
   *  `--` tail (`dor split -- <command>` or an empty `dor split --`) and an
   *  initial command both leave focus put. The host honors it as sent. */
  focusNeutral: boolean;
}

export interface SplitSurfaceResponse {
  status: 'created';
  surfaceId: string;
  surfaceRef: string;
  direction: ResolvedSplitDirection;
  minimized: boolean;
  command?: string;
}

export interface EnsureSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  /** Raw argv for the command; the host quotes it for the target shell. */
  command: string[];
  minimized: boolean;
  /** Interrupt and re-run a matching surface in place instead of reusing it. */
  restart: boolean;
  surface?: string;
  /** Working directory for matching and for the new command; part of the idempotency key. */
  cwd: string;
}

export interface EnsureSurfaceResponse {
  status: 'created' | 'existing' | 'restarted';
  surfaceId: string;
  surfaceRef: string;
  command: string;
  cwd: string;
  minimized: boolean;
}

export interface SendSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  surface: string;
  input: string;
  inputCount: number;
}

export interface SendSurfaceResponse {
  status: 'sent';
  surfaceId: string;
  surfaceRef: string;
  inputCount: number;
}

export interface ReadSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  lines?: number;
  scrollback: boolean;
  surface: string;
}

export interface ReadSurfaceResponse {
  workspaceRef: string;
  surfaceId: string;
  surfaceRef: string;
  text: string;
}

/** How much evidence of completion a `dor await` caller will accept
 *  (`docs/specs/alert.md` → Await). */
export type AwaitUntil = 'quiet' | 'exit';

/** Why a resolved await stopped waiting. */
export type AwaitCause = 'quiet' | 'exit' | 'bell' | 'idle';

/** How an await ended. `cancelled` never reaches a client: it only happens once
 *  the client is already gone, and nothing it responds with could be delivered. */
export type AwaitSurfaceOutcome = 'resolved' | 'timeout' | 'died';

export interface AwaitSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  surface: string;
  until: AwaitUntil;
  /** The caller's ceiling, enforced host-side so no hop can reap the wait early. */
  timeoutMs: number;
}

export interface AwaitSurfaceResponse {
  workspaceRef: string;
  surfaceId: string;
  surfaceRef: string;
  outcome: AwaitSurfaceOutcome;
  /** Present iff `outcome === 'resolved'`. */
  cause?: AwaitCause;
  /** The host's own measurement of the wait; the CLI never re-measures it. */
  waitedMs: number;
}

export type KillSurfaceConfirmation =
  | { mode: 'if-read'; text: string }
  | { mode: 'dangerously' };

export interface KillSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  confirmation: KillSurfaceConfirmation;
  surface: string;
}

export interface KillSurfaceResponse {
  status: 'killed';
  surfaceId: string;
  surfaceRef: string;
}

export interface IframeSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  minimized: boolean;
  surface?: string;
  url: string;
}

export interface IframeSurfaceResponse {
  status: 'created' | 'replaced';
  surfaceId: string;
  surfaceRef: string;
  url: string;
  minimized: boolean;
}

export interface ResolveOpenTargetRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  /** A terminal Surface handle (surface:N, surface:<stable-id>, surface:self,
   *  surface:focused) whose dev-server URL should be resolved. */
  surface: string;
}

export interface ResolveOpenTargetResponse {
  surfaceId: string;
  surfaceRef: string;
  /** The URL to open — `http://localhost:<port>/` for the single owned port. */
  url: string;
  /** The resolved listening port. */
  port: number;
}

export interface ResolveAgentBrowserSessionRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  /** A Surface handle (surface:N, surface:<stable-id>, surface:self,
   *  surface:focused, title:<title>) naming the browser Surface to drive. */
  surface: string;
}

export interface ResolveAgentBrowserSessionResponse {
  surfaceId: string;
  surfaceRef: string;
  /** The agent-browser session bound to that Surface — what `dor ab --surface`
   *  forwards as `--session`. Includes GUI-minted sessions, which no `--key`
   *  can name. */
  session: string;
}

export interface AgentBrowserSurfaceRequest {
  /** Act in this Workspace instead of the caller's (`dor --workspace <ref>`).
   *  Resolved by the router before caller ownership. */
  workspace?: string;
  /** Managed workspace-scoped key; absent when attaching via raw --session. */
  key?: string;
  /** Resolved agent-browser session name — the join key for the surface. */
  session: string;
  /** Session stream WebSocket port from `stream status --json`. */
  wsPort?: number;
  /** Absolute path of the agent-browser binary, resolved with the invoking
   * terminal's PATH so the host (which may lack it) can run tab/close. */
  binaryPath?: string;
}

export interface AgentBrowserSurfaceResponse {
  status: 'created' | 'existing' | 'replaced';
  surfaceId: string;
  surfaceRef: string;
  session: string;
  minimized: boolean;
}

export interface ControlClient {
  listSurfaces(request: ListSurfacesRequest): Promise<ListSurfacesResponse>;
  splitSurface(request: SplitSurfaceRequest): Promise<SplitSurfaceResponse>;
  ensureSurface(request: EnsureSurfaceRequest): Promise<EnsureSurfaceResponse>;
  sendSurface(request: SendSurfaceRequest): Promise<SendSurfaceResponse>;
  readSurface(request: ReadSurfaceRequest): Promise<ReadSurfaceResponse>;
  awaitSurface(request: AwaitSurfaceRequest): Promise<AwaitSurfaceResponse>;
  killSurface(request: KillSurfaceRequest): Promise<KillSurfaceResponse>;
  iframeSurface(request: IframeSurfaceRequest): Promise<IframeSurfaceResponse>;
  agentBrowserSurface(request: AgentBrowserSurfaceRequest): Promise<AgentBrowserSurfaceResponse>;
  resolveOpenTarget(request: ResolveOpenTargetRequest): Promise<ResolveOpenTargetResponse>;
  resolveAgentBrowserSession(
    request: ResolveAgentBrowserSessionRequest,
  ): Promise<ResolveAgentBrowserSessionResponse>;
  listWorkspaces(request: ListWorkspacesRequest): Promise<ListWorkspacesResponse>;
  newWorkspace(request: NewWorkspaceRequest): Promise<WorkspaceMutationResponse>;
  renameWorkspace(request: RenameWorkspaceRequest): Promise<WorkspaceMutationResponse>;
  closeWorkspace(request: CloseWorkspaceRequest): Promise<WorkspaceMutationResponse>;
  switchWorkspace(request: SwitchWorkspaceRequest): Promise<WorkspaceMutationResponse>;
}

export interface AgentBrowserExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/** Runs the user's agent-browser binary; injectable so CLI tests stay hermetic. */
export type AgentBrowserExec = (binary: string, args: string[]) => Promise<AgentBrowserExecResult>;

export interface CliEnv {
  [key: string]: string | undefined;
}

export interface CliOptions {
  env?: CliEnv;
  client?: ControlClient;
  readStdin?: () => Promise<string>;
  versionMetadata?: VersionMetadata;
  execAgentBrowser?: AgentBrowserExec;
}

export interface CliResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface DorCommandContext extends CommandContext {
  /** Narrower than stricli's `CommandContext`, which exposes only the writable
   *  streams. `cli.ts` always supplies a full `StricliProcess`, and a command
   *  that needs an exit code other than `dor`'s usual 0/1 sets `exitCode` on it
   *  directly (`dor await`); stricli assigns its own with `??=`, so the
   *  command's wins. */
  readonly process: StricliProcess;
  readonly options: CliOptions;
  /** Whether the raw argv carried the `--` argument-escape sequence. stricli
   *  consumes `--` and leaves no trace in the parsed positionals, so this is the
   *  only way a command can tell `dor split --` (empty tail) from a bare
   *  `dor split`. Computed once in `cli.ts` from the pre-parse argv. */
  readonly hasArgumentEscape: boolean;
}

export interface Command {
  name: string;
  command: StricliCommand<DorCommandContext>;
  helpPatches?: readonly HelpPatch[];
  /** Argv validation that must run *before* stricli parses (e.g. the `--` command
   *  tail in `dor ensure`, or `dor send`'s input-flag ordering). Defined next to
   *  the command's flags so the check and the flag list can't drift apart; `cli.ts`
   *  dispatches it generically. Receives argv with the command name already
   *  stripped, and is skipped for help invocations. */
  preParse?: (args: string[]) => ParseResult<void>;
}

export interface VersionMetadata {
  version: string;
  commit: string;
  commitsSinceVersion: number;
}

export interface HelpPatch {
  scope: 'root' | 'command-usage' | 'command-detail';
  /** Ordered template-pattern find/replace pairs. Tokens: <LS>, <WS>, <TO-EOL>. */
  findReplace?: readonly string[];
  /** Template patterns replaced with an empty string. Tokens: <LS>, <WS>, <TO-EOL>. */
  remove?: readonly string[];
}

export type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

import type {
  Command as StricliCommand,
  CommandContext,
  StricliProcess,
} from '@stricli/core';

export type IdFormat = 'refs' | 'ids' | 'both';
export type SplitDirection = 'left' | 'right' | 'up' | 'down' | 'auto';
export type ResolvedSplitDirection = 'left' | 'right' | 'up' | 'down';
export type SurfaceKind = 'terminal' | 'browser' | 'tool';
export type SurfaceRenderMode = 'iframe' | 'ab-screencast' | 'ab-popout';

/** What each kind is backed by (`docs/specs/glossary.md` → Panes and Surfaces).
 *  The single source of capability gating; kind switches elsewhere go through
 *  the predicates below. `Record<SurfaceKind, ...>` on purpose: adding a kind
 *  must be a compile error here, not a silent `false`. */
const KIND_CAPABILITIES: Record<SurfaceKind, { terminal: boolean; browser: boolean }> = {
  terminal: { terminal: true, browser: false },
  browser: { terminal: false, browser: true },
  // A tool is one Session with both: the PTY running the command, and the
  // browser it grows once it serves (`docs/specs/dor-tool.md`). Verbs gate on
  // the capability they need, so both sides of a row populate.
  tool: { terminal: true, browser: true },
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
}

export interface ListSurfacesRequest {
  pane?: string;
  workspace?: string;
  window?: string;
  /** Enumerate each terminal Surface's listening ports. The host shells out per
   *  pane (lsof / PowerShell), so callers opt in; remote sessions report none. */
  includePorts?: boolean;
}

export interface ListSurfacesResponse {
  surfaces: Surface[];
  workspaceRef: string;
  windowRef: string;
}

export interface SplitSurfaceRequest {
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

/**
 * `dor tool`. Two forms, differing only in whether the tool has an identity:
 * `name` runs a `dormouse.yml` entry with whatever `prespawn_dedupe` it
 * declares; `command` designates an arbitrary command as a tool with no key.
 * Exactly one is set. Host-resolved on purpose — the CLI never reads the tool
 * file, so a caller cannot hand the host a command while claiming the file
 * authorized it (`docs/specs/dor-tool.md` -> Trust).
 */
export interface ToolSurfaceRequest {
  /** Registered tool name (`dor tool <name>`). */
  name?: string;
  /** Raw argv (`dor tool -- <command>`); the host quotes it for the shell. */
  command?: string[];
  /** Ignore any declared key and always create — `--fresh`. */
  fresh: boolean;
  minimized: boolean;
  /** Working directory: resolves the tool file and runs the command. */
  cwd: string;
  /** Surface to split when creating. */
  surface?: string;
}

export interface ToolSurfaceResponse {
  /**
   * `existing` is a key match on a live tool: the redundant spawn never
   * started. `adopted` is a key match whose command had exited — the Surface is
   * reused and the command re-run in place, keeping its position and scrollback.
   */
  status: 'created' | 'existing' | 'adopted' | 'pending';
  surfaceId: string;
  surfaceRef: string;
  /** The rendered command, as typed into the shell. */
  command: string;
  cwd: string;
  minimized: boolean;
  /** The resolved dedupe key, or null when the tool has no identity. */
  key: string[] | null;
  /** Non-fatal `dormouse.yml` lint output, printed to stderr by the CLI. */
  warnings?: string[];
}

export interface SendSurfaceRequest {
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
  confirmation: KillSurfaceConfirmation;
  surface: string;
}

export interface KillSurfaceResponse {
  status: 'killed';
  surfaceId: string;
  surfaceRef: string;
}

export interface IframeSurfaceRequest {
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
  toolSurface(request: ToolSurfaceRequest): Promise<ToolSurfaceResponse>;
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

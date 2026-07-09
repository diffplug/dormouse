import type {
  Command as StricliCommand,
  CommandContext,
} from '@stricli/core';

export type IdFormat = 'refs' | 'ids' | 'both';
export type SplitDirection = 'left' | 'right' | 'up' | 'down' | 'auto';
export type ResolvedSplitDirection = 'left' | 'right' | 'up' | 'down';
export type SurfaceKind = 'terminal' | 'browser';
export type SurfaceRenderMode = 'iframe' | 'ab-screencast' | 'ab-popout';

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
  paneRef: string;
  kind: SurfaceKind;
  renderMode: SurfaceRenderMode | null;
  title: string;
  focused: boolean;
  index: number;
  indexInPane: number;
  selectedInPane: boolean;
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

export interface SendSurfaceRequest {
  surface?: string;
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
  surface?: string;
}

export interface ReadSurfaceResponse {
  workspaceRef: string;
  surfaceId: string;
  surfaceRef: string;
  text: string;
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
  sendSurface(request: SendSurfaceRequest): Promise<SendSurfaceResponse>;
  readSurface(request: ReadSurfaceRequest): Promise<ReadSurfaceResponse>;
  killSurface(request: KillSurfaceRequest): Promise<KillSurfaceResponse>;
  iframeSurface(request: IframeSurfaceRequest): Promise<IframeSurfaceResponse>;
  agentBrowserSurface(request: AgentBrowserSurfaceRequest): Promise<AgentBrowserSurfaceResponse>;
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
  readonly options: CliOptions;
}

export interface Command {
  name: string;
  command: StricliCommand<DorCommandContext>;
  helpPatches?: readonly HelpPatch[];
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

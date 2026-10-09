import { runCli as runCliOn } from './cli-core.js';
import type { CliHost, CliOptions, CliResult } from './commands/types.js';
import { NODE_HOST } from './node-host.js';

export type {
  AppRestartResponse,
  AwaitCause,
  AwaitSurfaceOutcome,
  AwaitSurfaceRequest,
  AwaitSurfaceResponse,
  AwaitUntil,
  BrowserExec,
  BrowserExecResult,
  BrowserSurfaceRequest,
  BrowserSurfaceResponse,
  CliEnv,
  CliOptions,
  CliResult,
  Command,
  ControlClient,
  DorCommandContext,
  EnsureSurfaceRequest,
  EnsureSurfaceResponse,
  IframeSurfaceRequest,
  IframeSurfaceResponse,
  MoveSurfaceRequest,
  MoveSurfaceResponse,
  KillSurfaceConfirmation,
  KillSurfaceRequest,
  KillSurfaceResponse,
  ListScope,
  ListSurfacesRequest,
  ListSurfacesResponse,
  ListWorkspacesRequest,
  ListWorkspacesResponse,
  NewWorkspaceRequest,
  CloseWorkspaceRequest,
  RenameWorkspaceRequest,
  SwitchWorkspaceRequest,
  PinWorkspaceRequest,
  WorkspaceMutationResponse,
  WorkspaceRow,
  ReadSurfaceRequest,
  ReadSurfaceResponse,
  ResolvedSplitDirection,
  ResolveOpenTargetRequest,
  ResolveOpenTargetResponse,
  SendSurfaceRequest,
  SendSurfaceResponse,
  SplitDirection,
  SplitSurfaceRequest,
  SplitSurfaceResponse,
  Surface,
  SurfaceActivity,
  SurfaceKind,
  SurfacePort,
  SurfaceRenderMode,
  SurfaceView,
  ToolSurfaceRequest,
  ToolSurfaceResponse,
  VersionMetadata,
} from './commands/types.js';

/** `dor` on this machine: `cli-core.ts` over the Node host, which a test may replace. */
export async function runCli(rawArgv: string[], options: Omit<CliOptions, 'host'> & { host?: CliHost } = {}): Promise<CliResult> {
  // Private host helper: stdout stays on a host-owned pipe, never a terminal
  // or control-socket response. The marker separates shell startup chatter.
  if (rawArgv[0] === '__launch-env' && rawArgv.length === 2 && /^[a-f0-9]{32}$/.test(rawArgv[1])) {
    const env = { ...(options.env ?? process.env) };
    delete env.ELECTRON_RUN_AS_NODE;
    // A JSON copy loses process.env's case-insensitive Windows lookup.
    if (process.platform === 'win32') {
      for (const key of Object.keys(env)) {
        const canonical = key.toUpperCase();
        if ((canonical === 'PATH' || canonical === 'PATHEXT') && key !== canonical) {
          env[canonical] = env[key];
          delete env[key];
        }
      }
    }
    return { stdout: `\n${rawArgv[1]}:${Buffer.from(JSON.stringify(env)).toString('base64')}\n`, stderr: '', exitCode: 0 };
  }

  return runCliOn(rawArgv, { ...options, host: options.host ?? NODE_HOST });
}

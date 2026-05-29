import type {
  Command as StricliCommand,
  CommandContext,
} from '@stricli/core';

export type IdFormat = 'refs' | 'uuids' | 'both';
export type SplitDirection = 'left' | 'right' | 'up' | 'down' | 'auto';
export type ResolvedSplitDirection = 'left' | 'right' | 'up' | 'down';

export interface Surface {
  id: string;
  ref: string;
  paneRef: string;
  type: 'terminal';
  title: string;
  focused: boolean;
  index: number;
  indexInPane: number;
  requestedWorkingDirectory: string | null;
  selectedInPane: boolean;
}

export interface ListSurfacesRequest {
  pane?: string;
  workspace?: string;
  window?: string;
}

export interface ListSurfacesResponse {
  surfaces: Surface[];
  workspaceRef: string;
  windowRef: string;
}

export interface SplitSurfaceRequest {
  command?: string;
  commandArgv?: string[];
  direction: SplitDirection;
  minimized: boolean;
  surface?: string;
}

export interface SplitSurfaceResponse {
  status: 'created';
  surfaceId?: string;
  surfaceRef: string;
  direction: ResolvedSplitDirection;
  minimized: boolean;
  command?: string;
}

export interface EnsureSurfaceRequest {
  command?: string;
  commandArgv?: string[];
  minimized: boolean;
  surface?: string;
  title?: string;
}

export interface EnsureSurfaceResponse {
  status: 'created' | 'existing';
  surfaceId?: string;
  surfaceRef: string;
  title: string;
  command: string;
  minimized: boolean;
}

export interface ControlClient {
  listSurfaces(request: ListSurfacesRequest): Promise<ListSurfacesResponse>;
  splitSurface(request: SplitSurfaceRequest): Promise<SplitSurfaceResponse>;
  ensureSurface(request: EnsureSurfaceRequest): Promise<EnsureSurfaceResponse>;
}

export interface CliEnv {
  [key: string]: string | undefined;
}

export interface CliOptions {
  env?: CliEnv;
  client?: ControlClient;
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

import { SocketControlClient } from './control-client.js';

export type IdFormat = 'refs' | 'uuids' | 'both';

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

export interface ControlClient {
  listSurfaces(request: ListSurfacesRequest): Promise<ListSurfacesResponse>;
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

interface ListSurfacesOptions {
  json: boolean;
  idFormat: IdFormat;
  pane?: string;
  workspace?: string;
  window?: string;
}

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const COMMANDS = new Set([
  'new-split',
  'list-surfaces',
  'list-panels',
  'list-pane-surfaces',
  'focus-surface',
  'focus-panel',
]);

export async function runCli(argv: string[], options: CliOptions = {}): Promise<CliResult> {
  const [command, ...args] = argv;
  if (!command || command === '-h' || command === '--help' || command === 'help') {
    return ok(printHelp());
  }

  if (!COMMANDS.has(command)) {
    return fail(`unknown command '${command}'`);
  }

  if (args.includes('-h') || args.includes('--help')) {
    return ok(printCommandHelp(command));
  }

  if (command === 'list-surfaces' || command === 'list-panels' || command === 'list-pane-surfaces') {
    return listSurfaces(command, args, options);
  }

  const endpointCheck = requireControlEndpoint(options);
  if (!endpointCheck.ok) return fail(endpointCheck.message);
  return fail(`command '${command}' is not implemented yet`);
}

function ok(stdout: string): CliResult {
  return { exitCode: 0, stdout, stderr: '' };
}

function fail(message: string): CliResult {
  return { exitCode: 1, stdout: '', stderr: `Error: ${message}\n` };
}

function printHelp(): string {
  return `dor - control Dormouse from a terminal

Usage:
  dor <command> [options]

Commands:
  new-split <left|right|up|down>
  list-surfaces
  focus-surface <surface>

Aliases:
  list-panels, list-pane-surfaces
  focus-panel
`;
}

function printCommandHelp(command: string): string {
  switch (command) {
    case 'new-split':
      return 'Usage: dor new-split <left|right|up|down> [--surface <id|ref|index>] [--panel <id|ref|index>] [--focus <true|false>] [--workspace <id|ref|index>] [--window <id|ref|index>]\n';
    case 'list-surfaces':
    case 'list-panels':
    case 'list-pane-surfaces':
      return 'Usage: dor list-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>] [--pane <id|ref|index>]\n';
    case 'focus-surface':
    case 'focus-panel':
      return 'Usage: dor focus-surface (--surface <id|ref|index> | --panel <id|ref|index>) [--workspace <id|ref|index>] [--window <id|ref|index>]\n       dor focus-surface <id|ref|index>\n';
    default:
      return '';
  }
}

async function listSurfaces(command: string, args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = parseListSurfacesArgs(command, args);
  if (!parsed.ok) return fail(parsed.message);

  const singletonCheck = validateSingletonTargets(parsed.value.workspace, parsed.value.window);
  if (!singletonCheck.ok) return fail(singletonCheck.message);

  const clientResult = resolveControlClient(options);
  if (!clientResult.ok) return fail(clientResult.message);

  try {
    const response = await clientResult.value.listSurfaces({
      pane: parsed.value.pane,
      workspace: parsed.value.workspace,
      window: parsed.value.window,
    });
    const stdout = parsed.value.json
      ? renderSurfacesJson(response, parsed.value.idFormat)
      : renderSurfacesText(response.surfaces, parsed.value.idFormat);
    return ok(stdout);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function parseListSurfacesArgs(command: string, args: string[]): ParseResult<ListSurfacesOptions> {
  const result: ListSurfacesOptions = {
    json: false,
    idFormat: 'refs',
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--id-format') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      if (!isIdFormat(value.value)) {
        return { ok: false, message: `invalid --id-format '${value.value}'` };
      }
      result.idFormat = value.value;
      index += 1;
    } else if (arg === '--pane') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.pane = value.value;
      index += 1;
    } else if (arg === '--workspace') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.workspace = value.value;
      index += 1;
    } else if (arg === '--window') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.window = value.value;
      index += 1;
    } else if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option '${arg}'` };
    } else {
      return { ok: false, message: `unexpected argument '${arg}'` };
    }
  }

  if (command === 'list-pane-surfaces' && !result.pane) {
    result.pane = 'focused';
  }

  return { ok: true, value: result };
}

function takeFlagValue(args: string[], index: number, flag: string): ParseResult<string> {
  const value = args[index + 1];
  if (!value || value.startsWith('-')) {
    return { ok: false, message: `${flag} requires a value` };
  }
  return { ok: true, value };
}

function isIdFormat(value: string): value is IdFormat {
  return value === 'refs' || value === 'uuids' || value === 'both';
}

function validateSingletonTargets(workspace: string | undefined, window: string | undefined): ParseResult<void> {
  if (workspace && workspace !== 'workspace:1' && workspace !== '1') {
    return { ok: false, message: `unsupported workspace target '${workspace}'` };
  }
  if (window && window !== 'window:1' && window !== '1') {
    return { ok: false, message: `unsupported window target '${window}'` };
  }
  return { ok: true, value: undefined };
}

function resolveControlClient(options: CliOptions): ParseResult<ControlClient> {
  if (options.client) return { ok: true, value: options.client };
  const endpointCheck = requireControlEndpoint(options);
  if (!endpointCheck.ok) return endpointCheck;
  return {
    ok: true,
    value: new SocketControlClient({
      socketPath: options.env!.DORMOUSE_CONTROL_SOCKET!,
      token: options.env!.DORMOUSE_CONTROL_TOKEN!,
      surfaceId: options.env!.DORMOUSE_SURFACE_ID,
    }),
  };
}

function requireControlEndpoint(options: CliOptions): ParseResult<void> {
  const env = options.env ?? {};
  if (!env.DORMOUSE_CONTROL_SOCKET || !env.DORMOUSE_CONTROL_TOKEN) {
    return { ok: false, message: 'Dormouse control endpoint is not available in this terminal yet.' };
  }
  return { ok: true, value: undefined };
}

function renderSurfacesText(surfaces: Surface[], idFormat: IdFormat): string {
  if (surfaces.length === 0) return '';
  return `${surfaces.map((surface) => renderSurfaceTextLine(surface, idFormat)).join('\n')}\n`;
}

function renderSurfaceTextLine(surface: Surface, idFormat: IdFormat): string {
  const prefix = surface.focused ? '*' : ' ';
  const handle = renderSurfaceHandle(surface, idFormat);
  const focused = surface.focused ? '  [focused]' : '';
  return `${prefix} ${handle}  ${surface.type}${focused}  ${JSON.stringify(surface.title)}`;
}

function renderSurfaceHandle(surface: Surface, idFormat: IdFormat): string {
  switch (idFormat) {
    case 'refs':
      return surface.ref;
    case 'uuids':
      return surface.id;
    case 'both':
      return `${surface.ref} ${surface.id}`;
  }
}

function renderSurfacesJson(response: ListSurfacesResponse, idFormat: IdFormat): string {
  const payload = {
    surfaces: response.surfaces.map((surface) => renderSurfaceJson(surface, idFormat)),
    window_ref: response.windowRef,
    workspace_ref: response.workspaceRef,
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderSurfaceJson(surface: Surface, idFormat: IdFormat): Record<string, unknown> {
  return {
    focused: surface.focused,
    ...(idFormat === 'uuids' || idFormat === 'both' ? { id: surface.id } : {}),
    index: surface.index,
    index_in_pane: surface.indexInPane,
    pane_ref: surface.paneRef,
    ...(idFormat === 'refs' || idFormat === 'both' ? { ref: surface.ref } : {}),
    requested_working_directory: surface.requestedWorkingDirectory,
    selected_in_pane: surface.selectedInPane,
    title: surface.title,
    type: surface.type,
  };
}

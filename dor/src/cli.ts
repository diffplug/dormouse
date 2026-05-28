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

interface Pane {
  id: string;
  ref: string;
  focused: boolean;
  index: number;
  selectedSurface: Surface;
  surfaces: Surface[];
}

type ListOutputMode = 'panes' | 'pane-surfaces' | 'surfaces';

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const COMMANDS = new Set([
  'new-split',
  'list-panes',
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

  if (command === 'list-panes' || command === 'list-surfaces' || command === 'list-panels' || command === 'list-pane-surfaces') {
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
  list-panes
  list-pane-surfaces
  list-panels
  focus-surface <surface>

Aliases:
  list-surfaces
  focus-panel
`;
}

function printCommandHelp(command: string): string {
  switch (command) {
    case 'new-split':
      return 'Usage: dor new-split <left|right|up|down> [--surface <id|ref|index>] [--panel <id|ref|index>] [--focus <true|false>] [--workspace <id|ref|index>] [--window <id|ref|index>]\n';
    case 'list-panes':
      return 'Usage: dor list-panes [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>]\n';
    case 'list-pane-surfaces':
      return 'Usage: dor list-pane-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--pane <id|ref|index>] [--window <id|ref|index>]\n';
    case 'list-panels':
    case 'list-surfaces':
      return 'Usage: dor list-panels [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>]\n';
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
    const mode = listOutputMode(command);
    const response = await clientResult.value.listSurfaces({
      pane: mode === 'panes' ? undefined : parsed.value.pane,
      workspace: parsed.value.workspace,
      window: parsed.value.window,
    });
    const stdout = renderListResponse(response, mode, parsed.value.idFormat, parsed.value.json);
    return ok(stdout);
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

function listOutputMode(command: string): ListOutputMode {
  if (command === 'list-panes') return 'panes';
  if (command === 'list-pane-surfaces') return 'pane-surfaces';
  return 'surfaces';
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

function renderListResponse(
  response: ListSurfacesResponse,
  mode: ListOutputMode,
  idFormat: IdFormat,
  json: boolean,
): string {
  if (mode === 'panes') {
    const panes = panesFromSurfaces(response.surfaces);
    return json
      ? renderPanesJson(response, panes, idFormat)
      : renderPanesText(panes, idFormat);
  }
  if (mode === 'pane-surfaces') {
    return json
      ? renderPaneSurfacesJson(response, idFormat)
      : renderPaneSurfacesText(response.surfaces, idFormat);
  }
  return json
    ? renderSurfacesJson(response, idFormat)
    : renderSurfacesText(response.surfaces, idFormat);
}

function panesFromSurfaces(surfaces: Surface[]): Pane[] {
  const panes = new Map<string, Pane>();
  for (const surface of surfaces) {
    let pane = panes.get(surface.paneRef);
    if (!pane) {
      pane = {
        id: surface.id,
        ref: surface.paneRef,
        focused: false,
        index: panes.size,
        selectedSurface: surface,
        surfaces: [],
      };
      panes.set(surface.paneRef, pane);
    }

    pane.surfaces.push(surface);
    pane.focused ||= surface.focused;
    if (surface.selectedInPane) {
      pane.selectedSurface = surface;
    }
  }
  return [...panes.values()];
}

function renderPanesText(panes: Pane[], idFormat: IdFormat): string {
  if (panes.length === 0) return '';
  return `${panes.map((pane) => renderPaneTextLine(pane, idFormat)).join('\n')}\n`;
}

function renderPaneTextLine(pane: Pane, idFormat: IdFormat): string {
  const prefix = pane.focused ? '*' : ' ';
  const handle = renderPaneHandle(pane, idFormat);
  const surfaceLabel = pane.surfaces.length === 1 ? 'surface' : 'surfaces';
  const focused = pane.focused ? '  [focused]' : '';
  return `${prefix} ${handle}  [${pane.surfaces.length} ${surfaceLabel}]${focused}`;
}

function renderPaneSurfacesText(surfaces: Surface[], idFormat: IdFormat): string {
  if (surfaces.length === 0) return '';
  return `${surfaces.map((surface) => renderPaneSurfaceTextLine(surface, idFormat)).join('\n')}\n`;
}

function renderPaneSurfaceTextLine(surface: Surface, idFormat: IdFormat): string {
  const prefix = surface.selectedInPane ? '*' : ' ';
  const handle = renderSurfaceHandle(surface, idFormat);
  const selected = surface.selectedInPane ? '  [selected]' : '';
  return `${prefix} ${handle}  ${surface.title}${selected}`;
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

function renderPaneHandle(pane: Pane, idFormat: IdFormat): string {
  switch (idFormat) {
    case 'refs':
      return pane.ref;
    case 'uuids':
      return pane.id;
    case 'both':
      return `${pane.ref} ${pane.id}`;
  }
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

function renderPanesJson(response: ListSurfacesResponse, panes: Pane[], idFormat: IdFormat): string {
  const payload = {
    panes: panes.map((pane) => renderPaneJson(pane, idFormat)),
    ...(idFormat === 'refs' || idFormat === 'both' ? { window_ref: response.windowRef } : {}),
    ...(idFormat === 'refs' || idFormat === 'both' ? { workspace_ref: response.workspaceRef } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderPaneJson(pane: Pane, idFormat: IdFormat): Record<string, unknown> {
  return {
    focused: pane.focused,
    ...(idFormat === 'uuids' || idFormat === 'both' ? { id: pane.id } : {}),
    index: pane.index,
    ...(idFormat === 'refs' || idFormat === 'both' ? { ref: pane.ref } : {}),
    ...(idFormat === 'uuids' || idFormat === 'both' ? { selected_surface_id: pane.selectedSurface.id } : {}),
    ...(idFormat === 'refs' || idFormat === 'both' ? { selected_surface_ref: pane.selectedSurface.ref } : {}),
    surface_count: pane.surfaces.length,
    ...(idFormat === 'uuids' || idFormat === 'both' ? { surface_ids: pane.surfaces.map((surface) => surface.id) } : {}),
    ...(idFormat === 'refs' || idFormat === 'both' ? { surface_refs: pane.surfaces.map((surface) => surface.ref) } : {}),
  };
}

function renderPaneSurfacesJson(response: ListSurfacesResponse, idFormat: IdFormat): string {
  const pane = panesFromSurfaces(response.surfaces)[0];
  const payload = {
    ...(pane && (idFormat === 'uuids' || idFormat === 'both') ? { pane_id: pane.id } : {}),
    ...(pane && (idFormat === 'refs' || idFormat === 'both') ? { pane_ref: pane.ref } : {}),
    surfaces: response.surfaces.map((surface) => renderPaneSurfaceJson(surface, idFormat)),
    ...(idFormat === 'refs' || idFormat === 'both' ? { window_ref: response.windowRef } : {}),
    ...(idFormat === 'refs' || idFormat === 'both' ? { workspace_ref: response.workspaceRef } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderPaneSurfaceJson(surface: Surface, idFormat: IdFormat): Record<string, unknown> {
  return {
    ...(idFormat === 'uuids' || idFormat === 'both' ? { id: surface.id } : {}),
    index: surface.indexInPane,
    ...(idFormat === 'refs' || idFormat === 'both' ? { ref: surface.ref } : {}),
    selected: surface.selectedInPane,
    title: surface.title,
    type: surface.type,
  };
}

function renderSurfacesJson(response: ListSurfacesResponse, idFormat: IdFormat): string {
  const payload = {
    surfaces: response.surfaces.map((surface) => renderSurfaceJson(surface, idFormat)),
    ...(idFormat === 'refs' || idFormat === 'both' ? { window_ref: response.windowRef } : {}),
    ...(idFormat === 'refs' || idFormat === 'both' ? { workspace_ref: response.workspaceRef } : {}),
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

import { SocketControlClient } from './control-client.js';

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
  command: string;
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

interface ListSurfacesOptions {
  json: boolean;
  idFormat: IdFormat;
  pane?: string;
  workspace?: string;
  window?: string;
}

interface SplitOptions {
  json: boolean;
  command?: string;
  direction: SplitDirection;
  minimized: boolean;
  surface?: string;
}

interface EnsureOptions {
  json: boolean;
  command: string;
  minimized: boolean;
  surface?: string;
  title?: string;
}

interface Pane {
  id: string;
  ref: string;
  focused: boolean;
  index: number;
  selectedSurface: Surface;
  surfaces: Surface[];
}

type ListOutputMode = 'panes' | 'pane-surfaces';

type ParseResult<T> =
  | { ok: true; value: T }
  | { ok: false; message: string };

const COMMANDS = new Set([
  'ensure',
  'list-panes',
  'list-pane-surfaces',
  'split',
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

  switch (command) {
    case 'list-panes':
    case 'list-pane-surfaces':
      return listSurfaces(command, args, options);
    case 'split':
      return splitSurface(args, options);
    case 'ensure':
      return ensureSurface(args, options);
    default:
      return fail(`unknown command '${command}'`);
  }
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
  split
  ensure
  list-panes
  list-pane-surfaces
`;
}

function printCommandHelp(command: string): string {
  switch (command) {
    case 'split':
      return 'Usage: dor split [--left|--right|--up|--down|--auto] [--command <cmd>] [--minimize] [--surface <id|ref|index>] [--json]\n';
    case 'ensure':
      return 'Usage: dor ensure [--title <title>] [--minimize] [--surface <id|ref|index>] [--json] -- <command...>\n';
    case 'list-panes':
      return 'Usage: dor list-panes [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--window <id|ref|index>]\n';
    case 'list-pane-surfaces':
      return 'Usage: dor list-pane-surfaces [--json] [--id-format refs|uuids|both] [--workspace <id|ref|index>] [--pane <id|ref|index>] [--window <id|ref|index>]\n';
    default:
      return '';
  }
}

async function splitSurface(args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = parseSplitArgs(args);
  if (!parsed.ok) return fail(parsed.message);

  const clientResult = resolveControlClient(options);
  if (!clientResult.ok) return fail(clientResult.message);

  try {
    const response = await clientResult.value.splitSurface(parsed.value);
    return ok(renderSplitResponse(response, parsed.value.json));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
  }
}

async function ensureSurface(args: string[], options: CliOptions): Promise<CliResult> {
  const parsed = parseEnsureArgs(args);
  if (!parsed.ok) return fail(parsed.message);

  const clientResult = resolveControlClient(options);
  if (!clientResult.ok) return fail(clientResult.message);

  try {
    const response = await clientResult.value.ensureSurface(parsed.value);
    return ok(renderEnsureResponse(response, parsed.value.json));
  } catch (error) {
    return fail(error instanceof Error ? error.message : String(error));
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
  return 'pane-surfaces';
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

function parseSplitArgs(args: string[]): ParseResult<SplitOptions> {
  const result: SplitOptions = {
    json: false,
    direction: 'auto',
    minimized: false,
  };
  let explicitDirection: SplitDirection | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--json') {
      result.json = true;
    } else if (arg === '--minimize') {
      result.minimized = true;
    } else if (arg === '--command') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.command = value.value;
      index += 1;
    } else if (arg === '--surface') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.surface = value.value;
      index += 1;
    } else if (isDirectionFlag(arg)) {
      const direction = directionFromFlag(arg);
      if (explicitDirection && explicitDirection !== direction) {
        return { ok: false, message: 'direction flags are mutually exclusive' };
      }
      explicitDirection = direction;
      result.direction = direction;
    } else if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option '${arg}'` };
    } else {
      return { ok: false, message: `unexpected argument '${arg}'` };
    }
  }

  return { ok: true, value: result };
}

function parseEnsureArgs(args: string[]): ParseResult<EnsureOptions> {
  const result: Omit<EnsureOptions, 'command'> & { command?: string } = {
    json: false,
    minimized: false,
  };
  let commandArgs: string[] | null = null;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--') {
      commandArgs = args.slice(index + 1);
      break;
    } else if (arg === '--json') {
      result.json = true;
    } else if (arg === '--minimize') {
      result.minimized = true;
    } else if (arg === '--title') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.title = value.value;
      index += 1;
    } else if (arg === '--surface') {
      const value = takeFlagValue(args, index, arg);
      if (!value.ok) return value;
      result.surface = value.value;
      index += 1;
    } else if (arg.startsWith('-')) {
      return { ok: false, message: `unknown option '${arg}'` };
    } else {
      return { ok: false, message: `unexpected argument '${arg}' before --` };
    }
  }

  if (!commandArgs) {
    return { ok: false, message: 'dor ensure requires -- <command...>' };
  }
  const command = commandArgs.join(' ').trim();
  if (!command) {
    return { ok: false, message: 'dor ensure requires a command after --' };
  }

  return { ok: true, value: { ...result, command } };
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

function isDirectionFlag(value: string): boolean {
  return value === '--left' || value === '--right' || value === '--up' || value === '--down' || value === '--auto';
}

function directionFromFlag(value: string): SplitDirection {
  switch (value) {
    case '--left':
      return 'left';
    case '--right':
      return 'right';
    case '--up':
      return 'up';
    case '--down':
      return 'down';
    default:
      return 'auto';
  }
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
  return json
    ? renderPaneSurfacesJson(response, idFormat)
    : renderPaneSurfacesText(response.surfaces, idFormat);
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
  return `${prefix} ${handle}  ${renderPaneSurfaceTitle(surface)}${selected}`;
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
    title: renderPaneSurfaceTitle(surface),
    type: surface.type,
  };
}

function renderPaneSurfaceTitle(surface: Surface): string {
  return surface.title;
}

function renderSplitResponse(response: SplitSurfaceResponse, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      status: response.status,
      ...(response.surfaceId ? { surface_id: response.surfaceId } : {}),
      surface_ref: response.surfaceRef,
      direction: response.direction,
      minimized: response.minimized,
      ...(response.command ? { command: response.command } : {}),
    }, null, 2)}\n`;
  }

  const minimized = response.minimized ? '  [minimized]' : '';
  const command = response.command ? `  ${JSON.stringify(response.command)}` : '';
  return `${response.status} ${response.surfaceRef}  [${response.direction}]${minimized}${command}\n`;
}

function renderEnsureResponse(response: EnsureSurfaceResponse, json: boolean): string {
  if (json) {
    return `${JSON.stringify({
      status: response.status,
      ...(response.surfaceId ? { surface_id: response.surfaceId } : {}),
      surface_ref: response.surfaceRef,
      title: response.title,
      command: response.command,
      minimized: response.minimized,
    }, null, 2)}\n`;
  }

  return `${response.status} ${response.surfaceRef}  ${JSON.stringify(response.title)}\n`;
}

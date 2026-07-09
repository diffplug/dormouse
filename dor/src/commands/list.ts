/**
 * `dor list` — the unified Surface listing. Replaces the old cmux-shaped
 * `list-panes` / `list-pane-surfaces` and folds in the identity dump that
 * `dor identify` used to print (caller / focused pointers + host block).
 *
 * Lists every Surface in the current Workspace, including minimized ones, and
 * optionally each terminal's listening ports (`--ports` / `--port`).
 */

import { resolve as resolvePath } from 'node:path';
import { buildCommand, type FlagParametersForType } from '@stricli/core';
import type {
  CliEnv,
  Command,
  DorCommandContext,
  IdFormat,
  ListSurfacesResponse,
  Surface,
  SurfaceKind,
  SurfacePort,
  SurfaceView,
} from './types.js';
import {
  errorMessage,
  parseIdFormat,
  renderHandle,
  renderJson,
  requireControlClient,
  stringParser,
  writeStdout,
} from './shared.js';

interface ListFlags {
  readonly command?: string;
  readonly cwd?: string;
  readonly idFormat?: IdFormat;
  readonly json?: boolean;
  readonly kind?: SurfaceKind;
  readonly port?: number;
  readonly ports?: boolean;
  readonly view?: SurfaceView;
}

const FULL_DESCRIPTION = `Lists every Surface in the current Workspace — terminals and browser Surfaces, including minimized ones (view "minimized").

Text output prints one row per Surface: a * marks the focused Surface, then the handle, kind, render mode ("-" for terminals), view, location (cwd for terminals, URL for browser Surfaces), and title. Trailing tags: (you) for the calling terminal, [ringing], [todo], and listening ports with --ports.

--ports adds each terminal's listening TCP ports. The host shells out per pane (lsof / PowerShell), so it is opt-in; remote sessions report none.

--port <number> filters to terminal Surfaces listening on that port. It implies the same opt-in port scan as --ports, includes port details in JSON, and shows port tags in text output.

Filters are ANDed. --command is an exact match against the running command reported by shell integration. --cwd resolves to an absolute path like dor ensure --cwd, relative to the invoking shell's PWD when available.

JSON output (--json) always includes both stable ids and refs, and adds top-level caller_surface_ref/caller_surface_id and focused_surface_ref/focused_surface_id — the calling and focused Surfaces, null when neither is in the list — plus workspace_ref, window_ref, and a host block (app, workspace, cli_js_path, node_path): the identity dump dor identify used to print.

Text output:
  * surface:1  terminal  -              paned  ~/projects/site  pnpm dev  :5173`;

export const listCommand: Command = {
  name: 'list',
  command: buildListCommand(),
};

function buildListCommand(): Command['command'] {
  const flags: FlagParametersForType<ListFlags, DorCommandContext> = {
    command: {
      kind: 'parsed',
      parse: stringParser,
      brief: 'Exact running command to match.',
      optional: true,
      placeholder: 'text',
    },
    cwd: {
      kind: 'parsed',
      parse: stringParser,
      brief: 'Working directory to match.',
      optional: true,
      placeholder: 'path',
    },
    idFormat: {
      kind: 'parsed',
      parse: parseIdFormat,
      brief: 'Handle format for text output.',
      optional: true,
      placeholder: 'refs|ids|both',
    },
    json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
    kind: {
      kind: 'parsed',
      parse: parseSurfaceKind,
      brief: 'Surface kind to show.',
      optional: true,
      placeholder: 'terminal|browser',
    },
    port: {
      kind: 'parsed',
      parse: parsePort,
      brief: 'Show terminal Surfaces listening on this TCP port.',
      optional: true,
      placeholder: 'number',
    },
    ports: {
      kind: 'boolean',
      brief: "Include each terminal's listening ports.",
      optional: true,
      withNegated: false,
    },
    view: {
      kind: 'parsed',
      parse: parseSurfaceView,
      brief: 'Surface view to show.',
      optional: true,
      placeholder: 'paned|zoomed|minimized',
    },
  };

  return buildCommand<ListFlags, [], DorCommandContext>({
    docs: {
      brief: 'List Dormouse Surfaces.',
      customUsage: ['[--kind terminal|browser] [--view paned|zoomed|minimized] [--command text] [--cwd path] [--port number] [--ports] [--json] [--id-format refs|ids|both]'],
      fullDescription: FULL_DESCRIPTION,
    },
    parameters: { flags },
    func(flags) {
      return runListCommand(flags, this);
    },
  });
}

async function runListCommand(
  flags: ListFlags,
  context: DorCommandContext,
): Promise<void | Error> {
  const client = requireControlClient(context.options);
  if (client instanceof Error) return client;

  try {
    const includePorts = flags.ports === true || flags.port !== undefined;
    const response = await client.listSurfaces({ includePorts });
    const env = context.options.env ?? {};
    const filtered = applyListFilters(response, flags, env);
    const idFormat = flags.idFormat ?? 'refs';
    const stdout = flags.json === true
      ? renderListJson(filtered, env, includePorts)
      : renderListText(filtered, env, idFormat, includePorts);
    writeStdout(context, stdout);
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function applyListFilters(
  response: ListSurfacesResponse,
  flags: ListFlags,
  env: CliEnv,
): ListSurfacesResponse {
  const cwd = flags.cwd === undefined ? undefined : callerWorkingDirectory(flags.cwd, env);
  return {
    ...response,
    surfaces: response.surfaces.filter((surface) => (
      (flags.kind === undefined || surface.kind === flags.kind) &&
      (flags.view === undefined || surface.view === flags.view) &&
      (flags.command === undefined || surface.command === flags.command) &&
      (cwd === undefined || surface.cwd === cwd) &&
      (flags.port === undefined || (surface.ports ?? []).some((port) => port.port === flags.port))
    )),
  };
}

function surfaceLocation(surface: Surface): string {
  return surface.cwd ?? surface.url ?? '';
}

function renderListText(
  response: ListSurfacesResponse,
  env: Record<string, string | undefined>,
  idFormat: IdFormat,
  includePorts: boolean,
): string {
  const surfaces = response.surfaces;
  if (surfaces.length === 0) return '';

  const callerId = env.DORMOUSE_SURFACE_ID;
  const handles = surfaces.map((surface) => renderHandle(surface, idFormat));
  const locations = surfaces.map(surfaceLocation);
  const renderModes = surfaces.map((surface) => surface.renderMode ?? '-');
  const handleWidth = Math.max(...handles.map((handle) => handle.length));
  const kindWidth = Math.max(...surfaces.map((surface) => surface.kind.length));
  const renderModeWidth = Math.max(...renderModes.map((renderMode) => renderMode.length));
  const viewWidth = Math.max(...surfaces.map((surface) => surface.view.length));
  const locationWidth = Math.max(...locations.map((location) => location.length));

  const lines = surfaces.map((surface, index) => {
    const marker = surface.focused ? '*' : ' ';
    const handle = handles[index].padEnd(handleWidth);
    const kind = surface.kind.padEnd(kindWidth);
    const renderMode = renderModes[index].padEnd(renderModeWidth);
    const view = surface.view.padEnd(viewWidth);
    const location = locations[index].padEnd(locationWidth);

    const tags: string[] = [];
    if (callerId !== undefined && surface.id === callerId) tags.push('(you)');
    if (surface.ringing) tags.push('[ringing]');
    if (surface.todo) tags.push('[todo]');
    if (includePorts && surface.ports && surface.ports.length > 0) {
      tags.push(surface.ports.map((port) => `:${port.port}`).join(' '));
    }
    const trailer = tags.length > 0 ? `  ${tags.join('  ')}` : '';

    return `${marker} ${handle}  ${kind}  ${renderMode}  ${view}  ${location}  ${surface.title}${trailer}`.trimEnd();
  });

  return `${lines.join('\n')}\n`;
}

function renderListJson(
  response: ListSurfacesResponse,
  env: Record<string, string | undefined>,
  includePorts: boolean,
): string {
  const callerId = env.DORMOUSE_SURFACE_ID;
  const caller = response.surfaces.find((surface) => surface.id === callerId) ?? null;
  const focused = response.surfaces.find((surface) => surface.focused) ?? null;

  const payload = {
    surfaces: response.surfaces.map((surface) => renderSurfaceJson(surface, includePorts)),
    caller_surface_ref: caller?.ref ?? null,
    caller_surface_id: caller?.id ?? null,
    focused_surface_ref: focused?.ref ?? null,
    focused_surface_id: focused?.id ?? null,
    window_ref: response.windowRef,
    workspace_ref: response.workspaceRef,
    host: {
      app: env.DORMOUSE_HOST ?? null,
      workspace: env.DORMOUSE_HOST_WORKSPACE ?? null,
      cli_js_path: env.DORMOUSE_CLI_JS ?? null,
      node_path: env.DORMOUSE_NODE ?? null,
    },
  };
  return renderJson(payload);
}

function renderSurfaceJson(
  surface: Surface,
  includePorts: boolean,
): Record<string, unknown> {
  return {
    id: surface.id,
    ref: surface.ref,
    pane_ref: surface.paneRef,
    kind: surface.kind,
    render_mode: surface.renderMode,
    view: surface.view,
    title: surface.title,
    focused: surface.focused,
    index: surface.index,
    cwd: surface.cwd,
    activity: surface.activity,
    ...(surface.exitCode !== undefined ? { exit_code: surface.exitCode } : {}),
    command: surface.command,
    url: surface.url,
    ringing: surface.ringing,
    todo: surface.todo,
    ...(includePorts && surface.kind === 'terminal'
      ? { ports: (surface.ports ?? []).map(renderPortJson) }
      : {}),
  };
}

function renderPortJson(port: SurfacePort): Record<string, unknown> {
  return {
    family: port.family,
    address: port.address,
    port: port.port,
    pid: port.pid,
    ...(port.processName ? { process_name: port.processName } : {}),
  };
}

function parseSurfaceKind(value: string): SurfaceKind {
  if (value === 'terminal' || value === 'browser') return value;
  throw new SyntaxError(`invalid --kind '${value}'`);
}

function parseSurfaceView(value: string): SurfaceView {
  if (value === 'paned' || value === 'zoomed' || value === 'minimized') return value;
  throw new SyntaxError(`invalid --view '${value}'`);
}

function parsePort(value: string): number {
  const port = Number(value);
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    throw new SyntaxError(`invalid --port '${value}'`);
  }
  return port;
}

function msysToWindowsCwd(pwd: string, platform: string): string {
  if (platform !== 'win32') return pwd;
  const match = pwd.match(/^\/([A-Za-z])\/(.*)$/);
  return match ? `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, '\\')}` : pwd;
}

function callerWorkingDirectory(flag: string, env: CliEnv): string {
  const base = msysToWindowsCwd(env.PWD ?? process.cwd(), process.platform);
  return resolvePath(base, flag);
}

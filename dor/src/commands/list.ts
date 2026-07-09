/**
 * `dor list` — the unified Surface listing. Replaces the old cmux-shaped
 * `list-panes` / `list-pane-surfaces` and folds in the identity dump that
 * `dor identify` used to print (caller / focused pointers + host block).
 *
 * Lists every Surface in the current Workspace, including minimized ones, and
 * optionally each terminal's listening ports (`--ports`).
 */

import { buildCommand, type FlagParametersForType } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  IdFormat,
  ListSurfacesResponse,
  Surface,
  SurfacePort,
} from './types.js';
import {
  errorMessage,
  parseIdFormat,
  renderHandle,
  renderJson,
  requireControlClient,
  writeStdout,
} from './shared.js';

interface ListFlags {
  readonly idFormat?: IdFormat;
  readonly json?: boolean;
  readonly ports?: boolean;
}

const FULL_DESCRIPTION = `Lists every Surface in the current Workspace — terminals and browser Surfaces, including minimized ones (view "minimized").

Text output prints one row per Surface: a * marks the focused Surface, then the handle, kind, render mode ("-" for terminals), view, location (cwd for terminals, URL for browser Surfaces), and title. Trailing tags: (you) for the calling terminal, [ringing], [todo], and listening ports with --ports.

--ports adds each terminal's listening TCP ports. The host shells out per pane (lsof / PowerShell), so it is opt-in; remote sessions report none.

JSON output (--json) always includes both stable ids and refs, and adds top-level caller_surface_ref/caller_surface_id and focused_surface_ref/focused_surface_id — the calling and focused Surfaces, null when neither is in the list — plus workspace_ref, window_ref, and a host block (app, workspace, cli_js_path, node_path): the identity dump dor identify used to print.

Text output:
  * surface:1  terminal  -              paned  ~/projects/site  pnpm dev  :5173`;

export const listCommand: Command = {
  name: 'list',
  command: buildListCommand(),
};

function buildListCommand(): Command['command'] {
  const flags: FlagParametersForType<ListFlags, DorCommandContext> = {
    idFormat: {
      kind: 'parsed',
      parse: parseIdFormat,
      brief: 'Handle format for text output.',
      optional: true,
      placeholder: 'refs|ids|both',
    },
    json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
    ports: {
      kind: 'boolean',
      brief: "Include each terminal's listening ports.",
      optional: true,
      withNegated: false,
    },
  };

  return buildCommand<ListFlags, [], DorCommandContext>({
    docs: {
      brief: 'List Dormouse Surfaces.',
      customUsage: ['[--ports] [--json] [--id-format refs|ids|both]'],
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
    const includePorts = flags.ports === true;
    const response = await client.listSurfaces({ includePorts });
    const env = context.options.env ?? {};
    const idFormat = flags.idFormat ?? 'refs';
    const stdout = flags.json === true
      ? renderListJson(response, env, includePorts)
      : renderListText(response, env, idFormat, includePorts);
    writeStdout(context, stdout);
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
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

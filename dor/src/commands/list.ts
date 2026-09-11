/**
 * `dor list` — the unified Surface listing. Replaces the old cmux-shaped
 * `list-panes` / `list-pane-surfaces` and folds in the identity dump that
 * `dor identify` used to print (caller / focused pointers + host block).
 *
 * Lists every Surface in the current Workspace, including minimized ones, and
 * optionally each terminal's listening ports (`--ports` / `--port`). It also
 * owns every cross-Workspace read: `--workspace` narrows to one, `--all` groups
 * every Workspace's Surfaces, and `--workspaces` is the overview
 * (`docs/specs/dor-cli.md` → "dor workspace" owns the mutation half).
 */

import { buildCommand, type FlagParametersForType } from '@stricli/core';
import type {
  CliEnv,
  Command,
  DorCommandContext,
  IdFormat,
  ListSurfacesResponse,
  ListWorkspacesResponse,
  Surface,
  SurfaceKind,
  SurfacePort,
  SurfaceView,
  WorkspaceRow,
  WorkspaceScopedFlags,
} from './types.js';
import { hasBrowser, hasTerminal, SURFACE_KINDS } from './types.js';
import {
  callerWorkingDirectory,
  errorMessage,
  parseIdFormat,
  parsePositiveInt,
  renderHandle,
  renderJson,
  requireControlClient,
  stringParser,
  workspaceFlag,
  workspaceParam,
  writeStdout,
} from './shared.js';

interface ListFlags extends WorkspaceScopedFlags {
  readonly all?: boolean;
  readonly command?: string;
  readonly cwd?: string;
  readonly idFormat?: IdFormat;
  readonly json?: boolean;
  readonly kind?: SurfaceKind;
  readonly port?: number;
  readonly ports?: boolean;
  readonly view?: SurfaceView;
  readonly workspaces?: boolean;
}

const FULL_DESCRIPTION = `Lists every Surface in the current Workspace — terminals and browser Surfaces, including minimized ones (view "minimized").

Text output prints one row per Surface: a * marks the focused Surface, then the handle, kind, render mode ("-" for terminals), view, location (cwd for terminals, URL for browser Surfaces), and title. Trailing tags: (you) for the calling terminal, [ringing], [todo], [awaited] while a dor await is parked on it, and listening ports with --ports.

--ports adds each terminal's listening TCP ports. The host shells out per pane (lsof / PowerShell), so it is opt-in; remote sessions report none.

--port <number> filters to terminal Surfaces listening on that port. It implies the same opt-in port scan as --ports, includes port details in JSON, and shows port tags in text output.

Filters are ANDed. --command is an exact match against the running command reported by shell integration. --cwd resolves to an absolute path like dor ensure --cwd, relative to the invoking shell's PWD when available.

JSON output (--json) always includes both stable ids and refs, and each row carries has_terminal (a PTY) and has_browser (a browser renderer) — gate on those, not on kind, so a Surface that has both still matches. It adds top-level caller_surface_ref/caller_surface_id and focused_surface_ref/focused_surface_id — the calling and focused Surfaces, null when neither is in the list — plus workspace_ref, window_ref, and a host block (app, workspace, cli_js_path, node_path): the identity dump dor identify used to print.

--workspace <ref> lists another Workspace instead, in this window or another: workspace:<n> (a stable number) or workspace:<name>, which resolves only when exactly one Workspace carries that name. Both are accepted bare ("2", "build").

--all lists every Workspace of this Window, grouped under a Workspace header — every Workspace keeps its header, including one holding nothing and one the filters emptied. Rows keep their own Workspace-scoped surface:N refs, so several groups have a surface:1, but only the active Workspace's selection carries the focus marker; each JSON row adds workspace_ref, and the payload adds a workspaces array plus caller_workspace_ref/focused_workspace_ref, because caller_surface_ref/focused_surface_ref then name a ref several groups share (the _id halves stay unique). Target a row from another Workspace by its stable id, or pass --workspace.

--workspaces prints the Workspace overview instead of any Surface: one row per Workspace with the active marker, its name, [ringing]/[todo] when any member Surface is, and [attention N] for the number owing it. It takes no other flag but --json.

Text output:
  * surface:1  terminal  -              paned  ~/projects/site  pnpm dev  :5173

  workspace:1  Workspace 1  [active]
    * surface:1  terminal  -  paned  ~/projects/site  pnpm dev

  * workspace:1  Workspace 1
    workspace:2  build        [ringing]  [attention 1]`;

export const listCommand: Command = {
  name: 'list',
  command: buildListCommand(),
};

function buildListCommand(): Command['command'] {
  const flags: FlagParametersForType<ListFlags, DorCommandContext> = {
    all: {
      kind: 'boolean',
      brief: 'List every Workspace, grouped by a Workspace header.',
      optional: true,
      withNegated: false,
    },
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
      placeholder: SURFACE_KINDS.join('|'),
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
    workspace: workspaceFlag,
    workspaces: {
      kind: 'boolean',
      brief: 'Print the Workspace overview instead of Surfaces.',
      optional: true,
      withNegated: false,
    },
  };

  return buildCommand<ListFlags, [], DorCommandContext>({
    docs: {
      brief: 'List Dormouse Surfaces.',
      customUsage: [
        '[--workspace ref|--all] [--kind terminal|browser] [--view paned|zoomed|minimized] [--command text] [--cwd path] [--port number] [--ports] [--json] [--id-format refs|ids|both]',
        '--workspaces [--json]',
      ],
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
  const scoping = checkScopeFlags(flags);
  if (!scoping.ok) return new Error(scoping.message);

  const client = requireControlClient(context.options);
  if (client instanceof Error) return client;

  try {
    if (flags.workspaces === true) {
      const overview = await client.listWorkspaces({});
      writeStdout(context, flags.json === true
        ? renderWorkspacesJson(overview)
        : renderWorkspacesText(overview));
      return undefined;
    }
    const includePorts = flags.ports === true || flags.port !== undefined;
    const response = await client.listSurfaces({
      includePorts,
      ...(flags.all === true ? { scope: 'all' as const } : {}),
      ...workspaceParam(flags.workspace),
    });
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

/** The only flags the Workspace overview takes — an allowlist, so a flag added
 *  to this command is refused there until it is named here. */
const WORKSPACES_FLAGS: ReadonlySet<keyof ListFlags> = new Set(['json', 'workspaces']);

/** A flag as the user typed it, from the name stricli parsed it into. */
function flagSpelling(name: string): string {
  return `--${name.replace(/[A-Z]/g, (upper) => `-${upper.toLowerCase()}`)}`;
}

/** The three container flags name one scope between them, and the overview is a
 *  different listing rather than a filter on this one. */
function checkScopeFlags(flags: ListFlags): { ok: true } | { ok: false; message: string } {
  if (flags.all === true && flags.workspace !== undefined) {
    return { ok: false, message: '--all and --workspace are mutually exclusive' };
  }
  if (flags.workspaces === true) {
    const others = (Object.keys(flags) as Array<keyof ListFlags>)
      .filter((name) => flags[name] !== undefined && !WORKSPACES_FLAGS.has(name))
      .map((name) => flagSpelling(name))
      .sort();
    if (others.length > 0) {
      return { ok: false, message: `dor list --workspaces takes only --json, not ${others.join(', ')}` };
    }
  }
  return { ok: true };
}

// Display predicates applied to the host's full surface projection. Cheap by
// construction: `--port` is the only filter here that needs host data beyond the
// projection, and it pays for it by opting into the port scan up in the caller.
// (Caller-identity targeting — the `pane` field — is filtered host-side in
// use-dor-control.ts.)
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

/**
 * Rows for one Workspace, or every group under its Workspace header when the
 * answer spans them (`--all`). Column widths are computed across every row, so
 * the groups line up with each other.
 */
function renderListText(
  response: ListSurfacesResponse,
  env: Record<string, string | undefined>,
  idFormat: IdFormat,
  includePorts: boolean,
): string {
  const rows = surfaceRows(response, env, idFormat, includePorts);
  if (!response.workspaces) return rows.length === 0 ? '' : `${rows.join('\n')}\n`;

  // Every row of a `--all` answer carries the Workspace it came from
  // (`GroupedSurface`), so a group is its own rows in response order. **Every
  // Workspace keeps its header**, even one no row survived: the listing says
  // which Workspaces there are, and the JSON payload lists them all either way.
  const groups = response.workspaces.map((workspace) => [
    `${workspace.ref}  ${workspace.name}${workspace.active ? '  [active]' : ''}`,
    ...response.surfaces.flatMap((surface, index) => (
      surface.workspaceRef === workspace.ref ? [`  ${rows[index]}`] : []
    )),
  ].join('\n'));
  return groups.length === 0 ? '' : `${groups.join('\n\n')}\n`;
}

/** The trailing tag block both listings share: two spaces before each tag. */
function tagTrailer(tags: string[]): string {
  return tags.length > 0 ? `  ${tags.join('  ')}` : '';
}

/** The attention tags a Surface row and a Workspace row spell the same way. */
function attentionTags(row: { ringing: boolean; todo: boolean }): string[] {
  return [...(row.ringing ? ['[ringing]'] : []), ...(row.todo ? ['[todo]'] : [])];
}

/** One text row per Surface, in response order, sharing one set of columns. */
function surfaceRows(
  response: ListSurfacesResponse,
  env: Record<string, string | undefined>,
  idFormat: IdFormat,
  includePorts: boolean,
): string[] {
  const surfaces = response.surfaces;
  if (surfaces.length === 0) return [];

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

    const tags = [
      ...(callerId !== undefined && surface.id === callerId ? ['(you)'] : []),
      ...attentionTags(surface),
      ...(surface.awaited ? ['[awaited]'] : []),
      ...(includePorts && surface.ports && surface.ports.length > 0
        ? [surface.ports.map((port) => `:${port.port}`).join(' ')]
        : []),
    ];

    return `${marker} ${handle}  ${kind}  ${renderMode}  ${view}  ${location}  ${surface.title}${tagTrailer(tags)}`.trimEnd();
  });

  return lines;
}

/** The Workspace overview (`dor list --workspaces`). */
function renderWorkspacesText(response: ListWorkspacesResponse): string {
  const rows = response.workspaces;
  if (rows.length === 0) return '';
  const refWidth = Math.max(...rows.map((row) => row.ref.length));
  const nameWidth = Math.max(...rows.map((row) => row.name.length));
  const lines = rows.map((row) => {
    const tags = [
      ...attentionTags(row),
      ...(row.count > 0 ? [`[attention ${row.count}]`] : []),
    ];
    return `${row.active ? '*' : ' '} ${row.ref.padEnd(refWidth)}  ${row.name.padEnd(nameWidth)}${tagTrailer(tags)}`.trimEnd();
  });
  return `${lines.join('\n')}\n`;
}

function renderWorkspacesJson(response: ListWorkspacesResponse): string {
  return renderJson({
    workspaces: response.workspaces.map(renderWorkspaceJson),
    window_ref: response.windowRef,
  });
}

function renderWorkspaceJson(row: WorkspaceRow): Record<string, unknown> {
  return {
    ref: row.ref,
    id: row.id,
    name: row.name,
    active: row.active,
    ringing: row.ringing,
    todo: row.todo,
    count: row.count,
  };
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
    // Under `--all` a `surface:N` ref is shared by every Workspace, so the two
    // ref pointers above name a row only together with the Workspace it is in;
    // the `_id` halves stay unique on their own.
    ...(response.workspaces ? {
      caller_workspace_ref: caller?.workspaceRef ?? null,
      focused_workspace_ref: focused?.workspaceRef ?? null,
      workspaces: response.workspaces.map(renderWorkspaceJson),
    } : {}),
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
    kind: surface.kind,
    // Derived at the JSON boundary: a kind *is* a capability set, so these are a
    // pure function of kind and are not carried as wire state.
    has_terminal: hasTerminal(surface.kind),
    has_browser: hasBrowser(surface.kind),
    render_mode: surface.renderMode,
    view: surface.view,
    title: surface.title,
    focused: surface.focused,
    cwd: surface.cwd,
    activity: surface.activity,
    ...(surface.exitCode !== undefined ? { exit_code: surface.exitCode } : {}),
    command: surface.command,
    url: surface.url,
    ringing: surface.ringing,
    todo: surface.todo,
    awaited: surface.awaited,
    ...(includePorts && hasTerminal(surface.kind)
      ? { ports: (surface.ports ?? []).map(renderPortJson) }
      : {}),
    // Only a cross-Workspace listing carries it; within one Workspace the
    // top-level `workspace_ref` already says which.
    ...(surface.workspaceRef ? { workspace_ref: surface.workspaceRef } : {}),
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
  const kind = SURFACE_KINDS.find((candidate) => candidate === value);
  if (kind) return kind;
  throw new SyntaxError(`invalid --kind '${value}'`);
}

function parseSurfaceView(value: string): SurfaceView {
  if (value === 'paned' || value === 'zoomed' || value === 'minimized') return value;
  throw new SyntaxError(`invalid --view '${value}'`);
}

function parsePort(value: string): number {
  return parsePositiveInt(value, '--port', 65535);
}

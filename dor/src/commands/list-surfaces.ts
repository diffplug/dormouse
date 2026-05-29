import {
  buildCommand,
  type FlagParametersForType,
} from '@stricli/core';
import type {
  Command as DorCommand,
  DorCommandContext,
  IdFormat,
  ListSurfacesResponse,
  Surface,
} from './types.js';
import {
  parseIdFormat,
  renderHandle,
  resolveControlClient,
  stringParser,
  validateSingletonTargets,
  wantsIds,
  wantsRefs,
  writeStdout,
} from './shared.js';

export type ListOutputMode = 'panes' | 'pane-surfaces';

interface ListFlags {
  readonly idFormat?: IdFormat;
  readonly json?: boolean;
  readonly pane?: string;
  readonly window?: string;
  readonly workspace?: string;
}

interface Pane {
  id: string;
  ref: string;
  focused: boolean;
  index: number;
  selectedSurface: Surface;
  surfaces: Surface[];
}

interface BuildListCommandOptions {
  brief: string;
  customUsage: string;
  fullDescription: string;
  mode: ListOutputMode;
}

export async function runListCommand(
  mode: ListOutputMode,
  flags: ListFlags,
  context: DorCommandContext,
): Promise<void | Error> {
  const workspace = flags.workspace;
  const window = flags.window;
  const singletonCheck = validateSingletonTargets(workspace, window);
  if (!singletonCheck.ok) return new Error(singletonCheck.message);

  const clientResult = resolveControlClient(context.options);
  if (!clientResult.ok) return new Error(clientResult.message);

  try {
    const pane = mode === 'pane-surfaces' ? (flags.pane ?? 'focused') : undefined;
    const response = await clientResult.value.listSurfaces({ pane, workspace, window });
    const idFormat = flags.idFormat ?? 'refs';
    const stdout = renderListResponse(response, mode, idFormat, flags.json === true);
    writeStdout(context, stdout);
    return undefined;
  } catch (error) {
    return new Error(error instanceof Error ? error.message : String(error));
  }
}

export function buildListCommand(options: BuildListCommandOptions): DorCommand['command'] {
  const flags: FlagParametersForType<ListFlags, DorCommandContext> = {
    idFormat: {
      kind: 'parsed',
      parse: parseIdFormat,
      brief: 'Handle format for listed ids.',
      optional: true,
      placeholder: 'refs|uuids|both',
    },
    json: { kind: 'boolean', brief: 'Print JSON output.', optional: true, withNegated: false },
    pane: {
      kind: 'parsed',
      parse: stringParser,
      brief: 'Pane or surface target.',
      optional: true,
      placeholder: 'id|ref|index',
      hidden: options.mode === 'panes',
    },
    window: {
      kind: 'parsed',
      parse: stringParser,
      brief: 'Window target.',
      optional: true,
      placeholder: 'id|ref|index',
    },
    workspace: {
      kind: 'parsed',
      parse: stringParser,
      brief: 'Workspace target.',
      optional: true,
      placeholder: 'id|ref|index',
    },
  };

  return buildCommand<ListFlags, [], DorCommandContext>({
    docs: {
      brief: options.brief,
      customUsage: [options.customUsage],
      fullDescription: options.fullDescription,
    },
    parameters: {
      flags,
    },
    func(flags) {
      return runListCommand(options.mode, flags, this);
    },
  });
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
  const handle = renderHandle(pane, idFormat);
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
  const handle = renderHandle(surface, idFormat);
  const selected = surface.selectedInPane ? '  [selected]' : '';
  return `${prefix} ${handle}  ${surface.title}${selected}`;
}

function renderPanesJson(response: ListSurfacesResponse, panes: Pane[], idFormat: IdFormat): string {
  const payload = {
    panes: panes.map((pane) => renderPaneJson(pane, idFormat)),
    ...(wantsRefs(idFormat) ? { window_ref: response.windowRef, workspace_ref: response.workspaceRef } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderPaneJson(pane: Pane, idFormat: IdFormat): Record<string, unknown> {
  return {
    focused: pane.focused,
    ...(wantsIds(idFormat) ? { id: pane.id } : {}),
    index: pane.index,
    ...(wantsRefs(idFormat) ? { ref: pane.ref } : {}),
    ...(wantsIds(idFormat) ? { selected_surface_id: pane.selectedSurface.id } : {}),
    ...(wantsRefs(idFormat) ? { selected_surface_ref: pane.selectedSurface.ref } : {}),
    surface_count: pane.surfaces.length,
    ...(wantsIds(idFormat) ? { surface_ids: pane.surfaces.map((surface) => surface.id) } : {}),
    ...(wantsRefs(idFormat) ? { surface_refs: pane.surfaces.map((surface) => surface.ref) } : {}),
  };
}

function renderPaneSurfacesJson(response: ListSurfacesResponse, idFormat: IdFormat): string {
  const pane = panesFromSurfaces(response.surfaces)[0];
  const payload = {
    ...(pane && wantsIds(idFormat) ? { pane_id: pane.id } : {}),
    ...(pane && wantsRefs(idFormat) ? { pane_ref: pane.ref } : {}),
    surfaces: response.surfaces.map((surface) => renderPaneSurfaceJson(surface, idFormat)),
    ...(wantsRefs(idFormat) ? { window_ref: response.windowRef, workspace_ref: response.workspaceRef } : {}),
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

function renderPaneSurfaceJson(surface: Surface, idFormat: IdFormat): Record<string, unknown> {
  return {
    ...(wantsIds(idFormat) ? { id: surface.id } : {}),
    index: surface.indexInPane,
    ...(wantsRefs(idFormat) ? { ref: surface.ref } : {}),
    selected: surface.selectedInPane,
    title: surface.title,
    type: surface.type,
  };
}

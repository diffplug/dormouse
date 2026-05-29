import type {
  CliOptions,
  CliResult,
  IdFormat,
  ListSurfacesResponse,
  ParseResult,
  Surface,
} from './types.js';
import {
  fail,
  isIdFormat,
  ok,
  renderHandle,
  resolveControlClient,
  takeFlagValue,
  validateSingletonTargets,
  wantsIds,
  wantsRefs,
} from './shared.js';

export type ListOutputMode = 'panes' | 'pane-surfaces';

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

export async function runListCommand(
  mode: ListOutputMode,
  args: string[],
  options: CliOptions,
): Promise<CliResult> {
  const parsed = parseListSurfacesArgs(mode, args);
  if (!parsed.ok) return fail(parsed.message);

  const singletonCheck = validateSingletonTargets(parsed.value.workspace, parsed.value.window);
  if (!singletonCheck.ok) return fail(singletonCheck.message);

  const clientResult = resolveControlClient(options);
  if (!clientResult.ok) return fail(clientResult.message);

  try {
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

function parseListSurfacesArgs(mode: ListOutputMode, args: string[]): ParseResult<ListSurfacesOptions> {
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

  if (mode === 'pane-surfaces' && !result.pane) {
    result.pane = 'focused';
  }

  return { ok: true, value: result };
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

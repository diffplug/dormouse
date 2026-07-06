/** Identity dump: caller/focused surfaces plus the hosting app (kind, workspace, runtime paths). */

import { buildCommand } from '@stricli/core';
import type {
  Command,
  DorCommandContext,
  IdFormat,
  ListSurfacesResponse,
  Surface,
} from './types.js';
import {
  errorMessage,
  parseIdFormat,
  renderJson,
  requireControlClient,
  wantsIds,
  wantsRefs,
  writeStdout,
} from './shared.js';

interface IdentifyFlags {
  readonly idFormat?: IdFormat;
}

export const identifyCommand: Command = {
  name: 'identify',
  command: buildCommand<IdentifyFlags, [], DorCommandContext>({
    docs: {
      brief: 'Print JSON identifying this terminal within Dormouse.',
      customUsage: ['[--id-format refs|uuids|both]'],
      fullDescription: `Prints a JSON object describing where this dor invocation sits within Dormouse: the caller surface (resolved from DORMOUSE_SURFACE_ID), the focused surface, and the hosting app.

host is "vscode" or "standalone". host_workspace is what the owning VS Code window has open — the .code-workspace file when one is loaded, else the root workspace folder; it is always null under the standalone app.

caller is null when no visible surface matches the invoking terminal (e.g. it was minimized to a Door); focused is null when no surface is focused. Environment-derived fields are null when the corresponding variable is absent.

Output is always JSON:
  {
    "caller": {
      "is_browser_surface": false,
      "pane_ref": "pane:1",
      "surface_ref": "surface:1",
      "surface_type": "terminal",
      "window_ref": "window:1",
      "workspace_ref": "workspace:1"
    },
    "cli_js_path": "/path/to/dor-cli/dist/dor.js",
    "focused": { ... },
    "host": "vscode",
    "host_workspace": "/path/to/project",
    "node_path": "/path/to/node"
  }`,
    },
    parameters: {
      flags: {
        idFormat: {
          kind: 'parsed',
          parse: parseIdFormat,
          brief: 'Handle format for surface handles.',
          optional: true,
          placeholder: 'refs|uuids|both',
        },
      },
    },
    func(flags) {
      return runIdentifyCommand(flags, this);
    },
  }),
};

async function runIdentifyCommand(
  flags: IdentifyFlags,
  context: DorCommandContext,
): Promise<void | Error> {
  const client = requireControlClient(context.options);
  if (client instanceof Error) return client;

  try {
    const response = await client.listSurfaces({});
    const env = context.options.env ?? {};
    const idFormat = flags.idFormat ?? 'refs';
    const caller = response.surfaces.find((surface) => surface.id === env.DORMOUSE_SURFACE_ID) ?? null;
    const focused = response.surfaces.find((surface) => surface.focused) ?? null;

    const payload = {
      caller: renderIdentitySurface(caller, response, idFormat),
      cli_js_path: env.DORMOUSE_CLI_JS ?? null,
      focused: renderIdentitySurface(focused, response, idFormat),
      host: env.DORMOUSE_HOST ?? null,
      host_workspace: env.DORMOUSE_HOST_WORKSPACE ?? null,
      node_path: env.DORMOUSE_NODE ?? null,
    };
    writeStdout(context, renderJson(payload));
    return undefined;
  } catch (error) {
    return new Error(errorMessage(error));
  }
}

function renderIdentitySurface(
  surface: Surface | null,
  response: ListSurfacesResponse,
  idFormat: IdFormat,
): Record<string, unknown> | null {
  if (!surface) return null;
  return {
    is_browser_surface: surface.type !== 'terminal',
    ...(wantsRefs(idFormat) ? { pane_ref: surface.paneRef } : {}),
    ...(wantsIds(idFormat) ? { surface_id: surface.id } : {}),
    ...(wantsRefs(idFormat) ? { surface_ref: surface.ref } : {}),
    surface_type: surface.type,
    ...(wantsRefs(idFormat) ? { window_ref: response.windowRef, workspace_ref: response.workspaceRef } : {}),
  };
}

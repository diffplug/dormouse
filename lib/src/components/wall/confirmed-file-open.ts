import type { OpenHandler, OpenHandlersResponse } from 'dor/commands/types';
import { SURFACE_CONTROL_METHODS, TOOL_CONTROL_METHODS } from 'dor/protocol';
import type { ExternalLinkSource } from '../../lib/external-link-confirmation';
import { getPlatform } from '../../lib/platform';
import { dispatchDorControlRequest } from '../../lib/platform/dor-control-dispatch';
import { wallHandleOwning } from './wall-handles';

/**
 * A confirmed `file:` link, opened as the `dor open` its originating Session
 * would run (`docs/specs/dor-tool.md` -> Terminal links): the picker's
 * `tool.openHandlers` candidates, then a `surface.tool` launch.
 */
export type FileLinkSource = Required<ExternalLinkSource>;

/** The source a confirmed file link opens from, or why it cannot open. */
export function fileLinkSource(source: ExternalLinkSource | undefined): FileLinkSource | string {
  if (!getPlatform().toolControl) return 'This host cannot open local files.';
  if (!source?.cwd) return 'The originating terminal or file directory is unavailable.';
  return { surfaceId: source.surfaceId, cwd: source.cwd };
}

export async function fileLinkViewers(uri: string, source: FileLinkSource): Promise<OpenHandler[]> {
  const response = await control<OpenHandlersResponse>(source, TOOL_CONTROL_METHODS.openHandlers, { target: uri, cwd: source.cwd });
  return response.handlers;
}

/** Opens `uri` with `tool`, or by default dispatch when it is undefined. */
export async function openFileLink(uri: string, source: FileLinkSource, tool: string | undefined): Promise<void> {
  // The router serves an unknown caller from the active Workspace, which is
  // not where a closed Session's link belongs.
  if (!wallHandleOwning(source.surfaceId)) throw new Error('The originating terminal is no longer available.');
  await control(source, SURFACE_CONTROL_METHODS.tool, { file: uri, surface: source.surfaceId, cwd: source.cwd, ...(tool ? { tool } : {}) });
}

function control<T>(source: FileLinkSource, method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise((resolve, reject) => dispatchDorControlRequest(
    { requestId: `confirmed-link-${crypto.randomUUID()}`, surfaceId: source.surfaceId, method, params },
    response => response.ok ? resolve(response.result as T) : reject(new Error(response.error ?? 'The file could not be opened.')),
  ));
}

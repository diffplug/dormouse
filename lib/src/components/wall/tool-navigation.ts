import { readToolViewPosition, type ToolViewPosition } from 'dor-tools-lib/protocol';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { parseRenderMode } from 'dor-lib-common/browser-providers';
import { builtinHandler, fileViewerFormat, runsOwnScript } from 'dor-tools-builtin/file-viewer-format';
import { getPlatform } from '../../lib/platform';
import { dispatchDorControlRequest } from '../../lib/platform/dor-control-dispatch';
import { toolEditorView } from '../../lib/tool-editor';
import { browserBindingFromParams } from './browser-surface';

export interface ToolLocation { target: string; handler?: string; cwd: string; position?: ToolViewPosition }
export interface ToolHistory { entries: readonly ToolLocation[]; index: number }
export interface ToolViewRequest { token: string; position: ToolViewPosition }

/** In leaf params so it follows live transfers and moves. The persistence
 * projection explicitly removes it. No file contents or capability URLs. */
export function toolHistory(params: Record<string, unknown> | undefined): ToolHistory | null {
  const value = params?.toolHistory as ToolHistory | undefined;
  return value && Array.isArray(value.entries) && Number.isInteger(value.index) && value.index >= 0 && value.index < value.entries.length ? value : null;
}

/** Whether the Surface has somewhere to go Back or Forward to. */
export function hasToolHistory(params: Record<string, unknown> | undefined): boolean {
  return (toolHistory(params)?.entries.length ?? 0) > 1;
}

/** A document navigation or its reading-position restore is under way. */
export function toolNavigationPending(params: Record<string, unknown> | undefined): boolean {
  return !!(params?.toolNavigating || params?.toolViewRequest);
}

/** The `open` handler name a Tool's scope and result `name` stand for. */
export function toolHandlerName(scope: unknown, name: unknown): string | undefined {
  if (typeof name !== 'string') return undefined;
  return scope === 'builtin' ? builtinHandler('kind', name)?.tool : name;
}

/**
 * Whether a document-link open of `target`, resolved to the handler `scope` and
 * `name` name, waits for the user to confirm it in host UI: the target is a
 * format whose built-in preview runs the file's own script, and the handler is
 * not a built-in that shows it inertly. A user or repository Tool given such a
 * file is assumed to render it too. A link may climb with `..` to anywhere on
 * disk under any link text, so the page cannot be the one that asks.
 */
export function documentLinkNeedsConfirmation(scope: unknown, name: unknown, target: string): boolean {
  const format = fileViewerFormat(target);
  if (!format || !runsOwnScript(format)) return false;
  const handler = toolHandlerName(scope, name);
  return handler !== 'builtin:code' && handler !== 'builtin:folder';
}

export function toolLocation(params: Record<string, unknown>, cwd: string): ToolLocation | null {
  if (typeof params.toolTarget !== 'string') return null;
  return { target: params.toolTarget, handler: toolHandlerName(params.toolScope, params.toolName), cwd };
}

export function commitToolHistory(previous: ToolHistory | null, current: ToolLocation, next: ToolLocation, index?: number): ToolHistory {
  const entries = previous ? [...previous.entries] : [current];
  const at = previous?.index ?? 0;
  entries[at] = current;
  if (index !== undefined) {
    entries[index] = next;
    return { entries, index };
  }
  entries.splice(at + 1, entries.length, next);
  // Bound session memory even for an indefinitely browsing Tool.
  const kept = entries.slice(-100);
  return { entries: kept, index: kept.length - 1 };
}

export function requestToolHistory(id: string, direction: 'back' | 'forward'): void {
  dispatchDorControlRequest({ requestId: `tool-history-${crypto.randomUUID()}`, surfaceId: id, method: SURFACE_CONTROL_METHODS.tool,
    params: { history: direction, disposition: 'current' } }, () => {});
}

/** The built-in Markdown editor is the one page exposing a reading position. */
export function hasToolView(params: Record<string, unknown> | undefined): boolean {
  return params?.toolScope === 'builtin' && params.toolName === 'file' && typeof params.toolTarget === 'string'
    && !!builtinHandler('kind', 'file')?.format(params.toolTarget)?.markdown;
}

/** Iframe and automation transports share the page's bounded reading-state
 * implementation. No arbitrary script crosses the platform boundary. */
export async function toolView(id: string, params: Record<string, unknown>, position?: ToolViewPosition): Promise<ToolViewPosition | undefined> {
  if (!hasToolView(params)) return undefined;
  const { provider } = parseRenderMode(params.renderMode);
  if (!provider) {
    const answer = toolEditorView(id, position);
    if (!answer) throw new Error('The document is still loading.');
    return answer;
  }
  const binding = browserBindingFromParams(params);
  const platform = getPlatform();
  if (!binding || !platform.browser) throw new Error('The document is still loading.');
  const answer = await platform.browser({ provider, binding, op: 'tool-view', ...(position === undefined ? {} : { position }) });
  if (!answer.ok) throw new Error(answer.error ?? 'Reading position unavailable.');
  return readToolViewPosition(answer.position) ?? undefined;
}

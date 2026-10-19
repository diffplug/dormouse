import { readToolViewPosition, type ToolViewPosition } from 'dor-tools-lib/protocol';
import { SURFACE_CONTROL_METHODS } from 'dor/protocol';
import { parseRenderMode } from 'dor-lib-common/browser-providers';
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

export function toolLocation(params: Record<string, unknown>, cwd: string): ToolLocation | null {
  if (typeof params.toolTarget !== 'string') return null;
  const name = typeof params.toolName === 'string' ? params.toolName : undefined;
  const handler = name && (params.toolScope === 'builtin' ? `builtin:${name}` : name);
  return { target: params.toolTarget, handler, cwd };
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
    params: { history: direction, disposition: 'current', fresh: false, minimized: false } }, () => {});
}

export function documentDirectory(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  const directory = path.slice(0, cut);
  return /^([A-Za-z]:)?$/.test(directory) ? path.slice(0, cut + 1) : directory;
}

export function hasToolView(params: Record<string, unknown> | undefined): boolean {
  return params?.toolScope === 'builtin' && params.toolName === 'file' && typeof params.toolTarget === 'string' && /\.(?:md|markdown)$/i.test(params.toolTarget);
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

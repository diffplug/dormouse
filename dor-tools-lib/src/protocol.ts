/**
 * The iframe save channel between a Tool's framed page and its host
 * (`docs/specs/dor-tool.md` -> Closing unsaved Tools). The host opens it with
 * `connect` under a per-mount nonce, `connection`, which every later message
 * repeats; the frame answers with its dirty state.
 *
 * `dorTool` is the protocol version and the discriminant: a message naming
 * another version is not this protocol's, and both ends ignore it.
 */

import { isRecord, sanitizeText } from './sanitize.js';
import { validToolFragment } from './osc.js';

/** Reading state only, never a document or an undo history. */
export interface ToolViewPosition { mode?: 'rich-text' | 'source'; top?: number; fragment?: string }
export function readToolViewPosition(value: unknown): ToolViewPosition | null {
  if (!isRecord(value) || (value.mode !== undefined && value.mode !== 'rich-text' && value.mode !== 'source')
    || (value.top !== undefined && (typeof value.top !== 'number' || !Number.isFinite(value.top) || value.top < 0 || value.top > 1e9))
    || (value.fragment !== undefined && !validToolFragment(value.fragment))) return null;
  return { ...(value.mode === undefined ? {} : { mode: value.mode }), ...(value.top === undefined ? {} : { top: value.top }), ...(value.fragment === undefined ? {} : { fragment: value.fragment }) };
}

export interface ToolViewAccess {
  read(): ToolViewPosition;
  apply(position: ToolViewPosition): Promise<void>;
}

export const DOR_TOOL_VERSION = 1;

const CONNECTION_LIMIT = 128;
const REQUEST_LIMIT = 64;
const ERROR_LIMIT = 1000;

/** Host → frame. */
export type HostMessage =
  | { dorTool: 1; kind: 'connect'; connection: string }
  | { dorTool: 1; kind: 'save' | 'view-read'; connection: string; request: string }
  | { dorTool: 1; kind: 'view-apply'; connection: string; request: string; position: ToolViewPosition };

/** Frame → host. Save/state messages carry dirty state; view messages cannot
 * change it. `ready` answers `connect`, `saved` settles `save`. */
export type FrameMessage =
  | { dorTool: 1; kind: 'ready' | 'state'; connection: string; dirty: boolean }
  | { dorTool: 1; kind: 'saved'; connection: string; request: string; dirty: boolean; error?: string }
  | { dorTool: 1; kind: 'view'; connection: string; request: string; position?: ToolViewPosition; error?: string };

const token = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;

/** A host message, or null for anything else — never throws. */
export function readHostMessage(data: unknown): HostMessage | null {
  if (!isRecord(data) || data.dorTool !== DOR_TOOL_VERSION || !token(data.connection, CONNECTION_LIMIT)) return null;
  const { connection } = data;
  if (data.kind === 'connect') return { dorTool: 1, kind: 'connect', connection };
  if ((data.kind === 'save' || data.kind === 'view-read') && token(data.request, REQUEST_LIMIT)) return { dorTool: 1, kind: data.kind, connection, request: data.request };
  const position = readToolViewPosition(data.position);
  if (data.kind === 'view-apply' && token(data.request, REQUEST_LIMIT) && position) return { dorTool: 1, kind: 'view-apply', connection, request: data.request, position };
  return null;
}

/** A frame message with its error text sanitized for display, or null for
 * anything else — never throws. */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || data.dorTool !== DOR_TOOL_VERSION || !token(data.connection, CONNECTION_LIMIT)) return null;
  if (data.kind === 'view' && token(data.request, REQUEST_LIMIT)) {
    const position = data.position === undefined ? undefined : readToolViewPosition(data.position);
    if (position === null) return null;
    return { dorTool: 1, kind: 'view', connection: data.connection, request: data.request, ...(position === undefined ? {} : { position }),
      ...(typeof data.error === 'string' ? { error: sanitizeText(data.error, ERROR_LIMIT) ?? 'Reading position unavailable.' } : {}) };
  }
  if (typeof data.dirty !== 'boolean') return null;
  const { connection, dirty } = data;
  if (data.kind === 'ready' || data.kind === 'state') return { dorTool: 1, kind: data.kind, connection, dirty };
  if (data.kind !== 'saved' || !token(data.request, REQUEST_LIMIT)) return null;
  const error = typeof data.error === 'string' ? sanitizeText(data.error, ERROR_LIMIT) ?? 'Save failed.' : undefined;
  return { dorTool: 1, kind: 'saved', connection, request: data.request, dirty, ...(error === undefined ? {} : { error }) };
}

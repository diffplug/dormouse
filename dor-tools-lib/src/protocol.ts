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

export const DOR_TOOL_VERSION = 1;

const CONNECTION_LIMIT = 128;
const REQUEST_LIMIT = 64;
const ERROR_LIMIT = 1000;

/** Host → frame. */
export type HostMessage =
  | { dorTool: 1; kind: 'connect'; connection: string }
  | { dorTool: 1; kind: 'save'; connection: string; request: string };

/** Frame → host. Each carries the document's dirty state at sending; `ready`
 * answers a `connect`, `state` reports a change, `saved` settles a `save`. */
export type FrameMessage =
  | { dorTool: 1; kind: 'ready' | 'state'; connection: string; dirty: boolean }
  | { dorTool: 1; kind: 'saved'; connection: string; request: string; dirty: boolean; error?: string };

const token = (value: unknown, limit: number): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= limit;

/** A host message, or null for anything else — never throws. */
export function readHostMessage(data: unknown): HostMessage | null {
  if (!isRecord(data) || data.dorTool !== DOR_TOOL_VERSION || !token(data.connection, CONNECTION_LIMIT)) return null;
  const { connection } = data;
  if (data.kind === 'connect') return { dorTool: 1, kind: 'connect', connection };
  if (data.kind === 'save' && token(data.request, REQUEST_LIMIT)) return { dorTool: 1, kind: 'save', connection, request: data.request };
  return null;
}

/** A frame message with its error text sanitized for display, or null for
 * anything else — never throws. */
export function readFrameMessage(data: unknown): FrameMessage | null {
  if (!isRecord(data) || data.dorTool !== DOR_TOOL_VERSION || !token(data.connection, CONNECTION_LIMIT)
    || typeof data.dirty !== 'boolean') return null;
  const { connection, dirty } = data;
  if (data.kind === 'ready' || data.kind === 'state') return { dorTool: 1, kind: data.kind, connection, dirty };
  if (data.kind !== 'saved' || !token(data.request, REQUEST_LIMIT)) return null;
  const error = typeof data.error === 'string' ? sanitizeText(data.error, ERROR_LIMIT) ?? 'Save failed.' : undefined;
  return { dorTool: 1, kind: 'saved', connection, request: data.request, dirty, ...(error === undefined ? {} : { error }) };
}

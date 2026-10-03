/**
 * OSC 367 — the Dor Tool announcement (`docs/specs/dor-tool.md` -> OSC 367).
 * `DOR` on a phone keypad; registered in `docs/specs/terminal-escapes.md`.
 * A Tool writes these sequences to its terminal; its host parses them.
 *
 * **The announcement never mints a tool.** `port` selects among the ports the
 * scan already sees; an announced port that nothing bound frames nothing.
 *
 * Verb-multiplexed like OSC 633, so the contract can grow without burning
 * registry numbers. The payload is untrusted process output that reaches UI, so
 * it is sanitized and size-capped like OSC 9/99/777 (`docs/specs/alert.md`).
 */

import { isRecord, sanitizeText } from './sanitize.js';

/** Cap on the whole payload before parsing. A tool's announcement is a handful
 *  of fields; anything larger is a mistake or an attack, and JSON.parse on
 *  unbounded terminal output is not something to offer. */
const PAYLOAD_LIMIT = 4096;
/** The serialized payload bound, which a host also applies to the
 *  `DEHYDRATE_ENV` value it sets on a rehydrated spawn. */
export const TOOL_PAYLOAD_LIMIT = PAYLOAD_LIMIT;
const NAME_LIMIT = 200;
const KEY_ELEMENT_LIMIT = 512;
const KEY_ELEMENTS_LIMIT = 8;

export type ToolAnnounce = {
  /** Which of the tool's ports to frame. Null when unstated. */
  port: number | null;
  /** Same-origin path/query for the discovered port; never an authority. */
  path?: string;
  /** Reserved announced-name title candidate; currently retained but inert. */
  name: string | null;
  /** Re-key request. Never dedupes — a runtime re-key only re-labels its own
   *  Surface, because a late collision between two Surfaces that both hold work
   *  cannot be resolved by killing either. */
  key: string[] | null;
  /** The run is safe to stop: its args alone restart it correctly, and on
   *  the graceful-stop signal it may emit a `dehydrate` payload for fidelity
   *  (`docs/specs/dor-tool.md` -> Reaping). */
  dehydrate: boolean;
  /** `never` vetoes reaping this run; `respawn` is the default. */
  persist: 'respawn' | 'never' | null;
};

function sanitize(value: unknown, limit: number): string | null {
  return typeof value === 'string' ? sanitizeText(value, limit) : null;
}

function readPort(value: unknown): number | null {
  if (typeof value !== 'number' || !Number.isInteger(value)) return null;
  return value >= 1 && value <= 65535 ? value : null;
}

function readKey(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length === 0 || value.length > KEY_ELEMENTS_LIMIT) return null;
  const elements: string[] = [];
  for (const element of value) {
    const cleaned = sanitize(element, KEY_ELEMENT_LIMIT);
    if (cleaned === null) return null;
    elements.push(cleaned);
  }
  return elements;
}

/**
 * Split `<verb>;<json>` for one OSC 367 verb and parse its object payload.
 * Returns null for another verb, an oversized or malformed payload, or a
 * non-object — never throws, because this runs on arbitrary process output.
 */
export function parseToolPayload(content: string, verb: string): Record<string, unknown> | null {
  if (!content.startsWith(`${verb};`)) return null;
  const raw = content.slice(verb.length + 1);
  if (raw.length === 0 || raw.length > PAYLOAD_LIMIT) return null;
  try {
    const payload: unknown = JSON.parse(raw);
    return isRecord(payload) ? payload : null;
  } catch {
    return null;
  }
}

/** Parse a `serve` announcement; `content` is everything after `367;`. */
export function parseToolAnnounce(content: string): ToolAnnounce | null {
  const record = parseToolPayload(content, 'serve');
  if (!record) return null;
  // A payload that names a version this parser does not speak is refused whole
  // rather than half-honored: a v2 `serve` may reuse a field name for something
  // else. `v` is optional — an omitted one is v1, the shipped shape — but a
  // stated one must be 1 (`docs/specs/dor-tool.md` -> OSC 367).
  if (record.v !== undefined && record.v !== 1) return null;

  const announce: ToolAnnounce = {
    port: readPort(record.port),
    ...(validToolServePath(record.path) ? { path: record.path } : {}),
    name: sanitize(record.name, NAME_LIMIT),
    key: readKey(record.key),
    dehydrate: record.dehydrate === true,
    persist: record.persist === 'never' ? 'never' : record.persist === 'respawn' ? 'respawn' : null,
  };
  // An announcement that says nothing actionable is not an announcement. A
  // reaping declaration alone is actionable: a terminal-only Tool has no port.
  if (announce.port === null && announce.name === null && announce.key === null
    && !announce.dehydrate && announce.persist === null) return null;
  return announce;
}

/** Reject authority changes rather than trying to repair process output. */
export function validToolServePath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && value.startsWith('/')
    && !value.startsWith('//') && !/[\\\u0000-\u0020\u007f-\u009f]/.test(value);
}

export interface ToolState { dirty: boolean }

/** Parse a `state` report; `content` is everything after `367;`. State is
 * independent of serving metadata. Reject unsupported versions and non-booleans
 * rather than treating absent or invalid data as clean. */
export function parseToolState(content: string): ToolState | null {
  const record = parseToolPayload(content, 'state');
  return record && record.v === 1 && typeof record.dirty === 'boolean' ? { dirty: record.dirty } : null;
}

export interface ToolOpen { path: string; preview: boolean }

const OPEN_PATH_LIMIT = 2048;

/** An absolute native path: POSIX, or a Windows drive path. Never a URL, a
 * relative path, or one carrying a control character. */
export function validToolOpenPath(value: unknown): value is string {
  return typeof value === 'string' && value.length <= OPEN_PATH_LIMIT
    && (value.startsWith('/') || /^[A-Za-z]:[\\/]/.test(value)) && !/[\u0000-\u001f\u007f-\u009f]/.test(value);
}

/** Parse an `open` request; `content` is everything after `367;`. `preview`
 * defaults to false, as `dor open` does. */
export function parseToolOpen(content: string): ToolOpen | null {
  const record = parseToolPayload(content, 'open');
  if (!record || record.v !== 1 || !validToolOpenPath(record.path)) return null;
  if (record.preview !== undefined && typeof record.preview !== 'boolean') return null;
  return { path: record.path, preview: record.preview === true };
}

export interface ServeOptions {
  /** The port to frame; omitted by a terminal-only Tool declaring only how it stops. */
  port?: number;
  /** The same-origin path to open on `port`. */
  path?: string;
  /** Safe to stop: args alone restart this run, and it may emit
   *  `dehydrateSequence` on the graceful-stop signal (Ctrl+C / `SIGINT`). */
  dehydrate?: boolean;
  /** `never` vetoes reaping this run. */
  persist?: 'respawn' | 'never';
}

/** The `serve` announcement a Tool writes once its server listens: the port to
 * frame and, optionally, the same-origin path to open on it, and whether the
 * host may stop it while idle. Throws on a value the host would ignore. */
export function serveSequence({ port, path, dehydrate, persist }: ServeOptions): string {
  if (port !== undefined && readPort(port) === null) throw new RangeError(`not a TCP port: ${port}`);
  if (path !== undefined && (port === undefined || !validToolServePath(path))) throw new RangeError(`not a same-origin path: ${JSON.stringify(path)}`);
  if (dehydrate !== undefined && typeof dehydrate !== 'boolean') throw new TypeError('dehydrate must be a boolean');
  if (persist !== undefined && persist !== 'respawn' && persist !== 'never') throw new RangeError(`not a persist policy: ${JSON.stringify(persist)}`);
  if (port === undefined && dehydrate !== true && persist === undefined) throw new RangeError('a serve announcement must state a port or how the Tool stops');
  return sequence('serve', {
    ...(port !== undefined ? { port } : {}), ...(path !== undefined ? { path } : {}),
    ...(dehydrate !== undefined ? { dehydrate } : {}), ...(persist !== undefined ? { persist } : {}), v: 1,
  });
}

/** The `state` report a Tool writes whenever its unsaved state changes. */
export function stateSequence({ dirty }: ToolState): string {
  if (typeof dirty !== 'boolean') throw new TypeError('dirty must be a boolean');
  return sequence('state', { v: 1, dirty });
}

/** The `open` request a Tool writes to show `path` in the Workspace's preview
 * slot (`preview`) or open it as `dor open` would. The host answers nothing;
 * a failure shows in the preview slot. Throws on a path the host would ignore. */
export function openSequence({ path, preview = false }: { path: string; preview?: boolean }): string {
  if (!validToolOpenPath(path)) throw new RangeError(`not an absolute path: ${JSON.stringify(path)}`);
  if (typeof preview !== 'boolean') throw new TypeError('preview must be a boolean');
  return sequence('open', { v: 1, path, preview });
}

/** The environment variable a rehydrated Tool reads its payload from. */
export const DEHYDRATE_ENV = 'DORMOUSE_DEHYDRATE';

export interface ToolDehydrate {
  /** The whole payload as the Tool emitted it: what `DEHYDRATE_ENV` carries. */
  payload: string;
}

/** Parse a `dehydrate` payload; `content` is everything after `367;`. The host
 * checks only its version and bound: the state is the Tool's own business,
 * handed back verbatim (`docs/specs/dor-tool.md` -> Reaping). */
export function parseToolDehydrate(content: string): ToolDehydrate | null {
  const record = parseToolPayload(content, 'dehydrate');
  if (!record || record.v !== 1 || record.state === undefined || record.state === null) return null;
  return { payload: content.slice('dehydrate;'.length) };
}

/** The `dehydrate` payload a Tool writes on the graceful-stop signal, just
 * before it exits: small JSON it reads back with `readDehydrated` when the
 * host restarts it. Never a document — the host refuses one past its limit,
 * and the Tool then restarts from its args alone. */
export function dehydrateSequence(state: unknown): string {
  if (state === undefined || state === null) throw new TypeError('dehydrate state must be a JSON value other than null');
  return sequence('dehydrate', { v: 1, state }, escapeC1);
}

/** JSON leaves DEL and the C1 controls raw, and a C1 ST inside a string would
 *  end the sequence early; the state is the Tool's own, so escape rather than
 *  refuse (docs/specs/dor-tool.rationale.md -> OSC 367). */
function escapeC1(raw: string): string {
  return raw.replace(/[\u007f-\u009f]/g, c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/** The state a rehydrated Tool was handed — pass `process.env.DORMOUSE_DEHYDRATE`
 * — or null for none: a missing, malformed, oversized, or unknown-version value
 * means start from args alone, never fail. */
export function readDehydrated<T = unknown>(value: string | undefined): T | null {
  if (typeof value !== 'string') return null;
  const parsed = parseToolDehydrate(`dehydrate;${value}`);
  return parsed ? (JSON.parse(parsed.payload) as { state: T }).state : null;
}

function sequence(verb: string, payload: object, encode: (raw: string) => string = raw => raw): string {
  // JSON escaping can expand a field beyond its own bound. The host caps the
  // serialized payload before parsing, so never emit a sequence it will ignore.
  const raw = encode(JSON.stringify(payload));
  if (raw.length > PAYLOAD_LIMIT) throw new RangeError('Tool payload exceeds its serialized size limit');
  return `\x1b]367;${verb};${raw}\x07`;
}

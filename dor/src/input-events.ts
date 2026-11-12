import type { ParseResult } from './commands/types.js';

export type SendInputEvent = { text: string } | { key: string };
/** Encoded at the terminal, retaining the event kind through host pacing. */
export type PtyInputEvent = { kind: 'text' | 'key'; data: string };
export const SEND_INPUT_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Validate the complete batch before consuming stdin or touching a PTY. */
export function validateInputEvents(value: unknown): ParseResult<SendInputEvent[]> {
  if (!Array.isArray(value) || value.length === 0) return { ok: false, message: 'input must be a nonempty event array' };
  for (const [index, item] of value.entries()) {
    if (!item || typeof item !== 'object' || Array.isArray(item) || Object.keys(item).length !== 1
      || !(typeof item.text === 'string' || typeof item.key === 'string')) {
      return { ok: false, message: `input event ${index + 1} must contain exactly one string text or key` };
    }
    if ('key' in item) {
      const encoded = encodeKey(item.key);
      if (!encoded.ok) return encoded;
    }
  }
  return { ok: true, value };
}

export function encodeInputEvents(events: readonly SendInputEvent[], applicationCursorKeys = false): PtyInputEvent[] {
  return events.map(event => {
    if ('text' in event) return { kind: 'text', data: event.text };
    const encoded = encodeKey(event.key, applicationCursorKeys);
    if (!encoded.ok) throw new Error(encoded.message);
    return { kind: 'key', data: encoded.value };
  });
}

export function encodeKey(input: string, applicationCursorKeys = false): ParseResult<string> {
  const key = input.trim().toLowerCase();
  switch (key) {
    case 'enter':
      return { ok: true, value: '\r' };
    case 'escape':
    case 'esc':
      return { ok: true, value: '\x1b' };
    case 'tab':
      return { ok: true, value: '\t' };
    case 'backspace':
      return { ok: true, value: '\x7f' };
    case 'delete':
      return { ok: true, value: '\x1b[3~' };
    case 'up':
      return { ok: true, value: `\x1b${applicationCursorKeys ? 'O' : '['}A` };
    case 'down':
      return { ok: true, value: `\x1b${applicationCursorKeys ? 'O' : '['}B` };
    case 'right':
      return { ok: true, value: `\x1b${applicationCursorKeys ? 'O' : '['}C` };
    case 'left':
      return { ok: true, value: `\x1b${applicationCursorKeys ? 'O' : '['}D` };
  }

  const ctrl = /^ctrl-([a-z])$/.exec(key);
  if (ctrl) {
    return { ok: true, value: String.fromCharCode(ctrl[1].charCodeAt(0) - 96) };
  }

  return { ok: false, message: `unsupported key '${input}'` };
}

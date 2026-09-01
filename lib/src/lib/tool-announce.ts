/**
 * OSC 367 — the Dor Tool announcement (`docs/specs/dor-tool.md` -> OSC 367).
 * `DOR` on a phone keypad; registered in `docs/specs/terminal-escapes.md`.
 *
 * **The announcement never mints a tool.** `port` selects among the ports the
 * scan already sees; an announced port that nothing bound frames nothing.
 *
 * Verb-multiplexed like OSC 633, so the contract can grow without burning
 * registry numbers. The payload is untrusted process output that reaches UI, so
 * it is sanitized and size-capped like OSC 9/99/777 (`docs/specs/alert.md`).
 */

import { sanitizeText } from './osc-sanitize';

/** Cap on the whole payload before parsing. A tool's announcement is a handful
 *  of fields; anything larger is a mistake or an attack, and JSON.parse on
 *  unbounded terminal output is not something to offer. */
const PAYLOAD_LIMIT = 4096;
const NAME_LIMIT = 200;
const KEY_ELEMENT_LIMIT = 512;
const KEY_ELEMENTS_LIMIT = 8;

export type ToolAnnounce = {
  /** Which of the tool's ports to frame. Null when unstated. */
  port: number | null;
  /** Title candidate, feeding the existing channel in terminal-state.md. */
  name: string | null;
  /** Re-key request. Never dedupes — a runtime re-key only re-labels its own
   *  Surface, because a late collision between two Surfaces that both hold work
   *  cannot be resolved by killing either. */
  key: string[] | null;
  /** Reserved for D2: the tool can produce a dehydrate payload on graceful stop. */
  dehydrate: boolean;
  /** Reserved for D1/D2 restart policy. */
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
 * Parse an OSC 367 payload. `content` is everything after `367;`, i.e.
 * `<verb>;<json>`. Returns null for an unknown verb, a malformed payload, or a
 * payload with nothing usable in it — never throws, because this runs on
 * arbitrary process output.
 */
export function parseToolAnnounce(content: string): ToolAnnounce | null {
  const separator = content.indexOf(';');
  if (separator === -1) return null;
  const verb = content.slice(0, separator);
  // `dehydrate` is D2's verb; parsed as unknown here rather than half-honored.
  if (verb !== 'serve') return null;
  const raw = content.slice(separator + 1);
  if (raw.length === 0 || raw.length > PAYLOAD_LIMIT) return null;

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof payload !== 'object' || payload === null || Array.isArray(payload)) return null;
  const record = payload as Record<string, unknown>;

  const announce: ToolAnnounce = {
    port: readPort(record.port),
    name: sanitize(record.name, NAME_LIMIT),
    key: readKey(record.key),
    dehydrate: record.dehydrate === true,
    persist: record.persist === 'never' ? 'never' : record.persist === 'respawn' ? 'respawn' : null,
  };
  // An announcement that says nothing actionable is not an announcement.
  if (announce.port === null && announce.name === null && announce.key === null) return null;
  return announce;
}

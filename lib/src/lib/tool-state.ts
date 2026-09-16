import { isRecord } from './is-record';

export interface ToolState { dirty: boolean }

/** OSC 367 state is independent of serving metadata. Reject unsupported
 * versions and non-booleans rather than treating absent/invalid data as clean. */
export function parseToolState(content: string): ToolState | null {
  if (!content.startsWith('state;')) return null;
  const raw = content.slice('state;'.length);
  if (!raw || raw.length > 4096) return null;
  try {
    const value: unknown = JSON.parse(raw);
    return isRecord(value) && value.v === 1 && typeof value.dirty === 'boolean'
      ? { dirty: value.dirty } : null;
  } catch { return null; }
}

import { parseToolPayload } from './tool-announce';

export interface ToolState { dirty: boolean }

/** OSC 367 state is independent of serving metadata. Reject unsupported
 * versions and non-booleans rather than treating absent/invalid data as clean. */
export function parseToolState(content: string): ToolState | null {
  const record = parseToolPayload(content, 'state');
  return record && record.v === 1 && typeof record.dirty === 'boolean' ? { dirty: record.dirty } : null;
}

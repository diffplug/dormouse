/**
 * This device's secret for {@link frameOriginFor}: so the frame domain's host
 * names no page, and no two phones share an origin. Losing it only moves frames
 * to new origins, which keep nothing anyway (`docs/specs/pocket-app.md` ->
 * "Frame origin").
 */

import { fromBase64Url, toBase64Url } from 'remote-lib-common';

const KEY = 'dormouse.pocket.frame-salt';
const BYTES = 32;

export function frameSalt(storage: Pick<Storage, 'getItem' | 'setItem'> | null = browserStorage()): Uint8Array {
  try {
    const stored = storage?.getItem(KEY);
    if (stored) {
      const salt = fromBase64Url(stored);
      if (salt.length === BYTES) return salt;
    }
  } catch {
    // Unreadable reads as none.
  }
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(BYTES));
  try {
    storage?.setItem(KEY, toBase64Url(salt));
  } catch {
    // Held for this page alone: the next load moves to new origins.
  }
  return salt;
}

function browserStorage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

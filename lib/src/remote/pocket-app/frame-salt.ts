/**
 * This tab's secret for {@link frameOriginFor}: so the frame domain's host names
 * no page, no two phones share an origin, and no two tabs do, which would share
 * one worker that cannot tell whose page asked. A reload keeps it; losing it only
 * moves frames to new origins (`docs/specs/pocket-app.md` -> "Frame origin").
 */

import { base64UrlLength, fromBase64Url, isExactBase64Url, toBase64Url } from 'remote-lib-common';

const KEY = 'dormouse.pocket.frame-salt';
const BYTES = 32;

/** Where no `sessionStorage` works: this page load alone. */
let unsaved: Uint8Array | null = null;

export function frameSalt(): Uint8Array {
  if (unsaved) return unsaved;
  try {
    const stored = sessionStorage.getItem(KEY);
    if (isExactBase64Url(stored, base64UrlLength(BYTES))) return fromBase64Url(stored);
    const salt = globalThis.crypto.getRandomValues(new Uint8Array(BYTES));
    sessionStorage.setItem(KEY, toBase64Url(salt));
    return salt;
  } catch {
    unsaved = globalThis.crypto.getRandomValues(new Uint8Array(BYTES));
    return unsaved;
  }
}

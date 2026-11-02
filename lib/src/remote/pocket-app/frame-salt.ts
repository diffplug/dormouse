/**
 * This tab's secret for {@link frameOriginFor}: so the frame domain's host names
 * no page, no two phones share an origin, and no two tabs do, which would share
 * one worker that cannot tell whose page asked. A reload keeps it, and a browser's
 * Duplicate Tab copies it, the one way two tabs still share. Losing it only moves
 * frames to new origins (`docs/specs/pocket-app.md` -> "Frame origin").
 */

import { base64UrlLength, fromBase64Url, isExactBase64Url, toBase64Url } from 'remote-lib-common';

const KEY = 'dormouse.pocket.frame-salt';
const mint = () => globalThis.crypto.getRandomValues(new Uint8Array(32));
const ENCODED_LENGTH = base64UrlLength(32);

/** Where no `sessionStorage` works: this page load alone. */
let unsaved: Uint8Array | null = null;

export function frameSalt(): Uint8Array {
  if (unsaved) return unsaved;
  try {
    const stored = sessionStorage.getItem(KEY);
    if (isExactBase64Url(stored, ENCODED_LENGTH)) return fromBase64Url(stored);
    const salt = mint();
    sessionStorage.setItem(KEY, toBase64Url(salt));
    return salt;
  } catch {
    unsaved = mint();
    return unsaved;
  }
}

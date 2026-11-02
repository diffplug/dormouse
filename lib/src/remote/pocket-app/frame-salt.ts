/**
 * This device's secret for {@link frameOriginFor}: so the frame domain's host
 * names no page, and no two phones share an origin. Losing it only moves frames
 * to new origins, which keep nothing anyway (`docs/specs/pocket-app.md` ->
 * "Frame origin").
 */

import { fromBase64Url, isBoundedBase64Url, toBase64Url } from 'remote-lib-common';
import { loadJson, saveJson } from '../../lib/local-json-store';

const KEY = 'dormouse.pocket.frame-salt';
const BYTES = 32;

const ENCODED_LENGTH = 43;

const isSalt = (value: unknown): value is string => isBoundedBase64Url(value, ENCODED_LENGTH) && value.length === ENCODED_LENGTH;

export function frameSalt(): Uint8Array {
  const stored = loadJson(KEY, null, isSalt);
  if (stored) return fromBase64Url(stored);
  const salt = globalThis.crypto.getRandomValues(new Uint8Array(BYTES));
  saveJson(KEY, toBase64Url(salt));
  return salt;
}

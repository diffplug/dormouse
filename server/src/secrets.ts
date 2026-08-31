/** Constant-time secret comparison, shared by every credential the server checks. */

import { createHash, timingSafeEqual } from 'node:crypto';

/** SHA-256 of a UTF-8 string, as a fixed 32-byte buffer. */
export function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf8').digest();
}

/** Constant-time compare of two secrets, via digests so lengths always match. */
export function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

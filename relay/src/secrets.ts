/** Constant-time secret comparison, shared by every credential the Relay checks. */

import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * SHA-256 of a string, as a fixed 32-byte buffer. Encoded UTF-16LE, not UTF-8:
 * UTF-8 folds every lone surrogate to U+FFFD, so two distinct JS strings could
 * digest equal, while UTF-16LE is injective on JS strings.
 */
function sha256(text: string): Buffer {
  return createHash('sha256').update(text, 'utf16le').digest();
}

/** Constant-time compare of two secrets, via digests so lengths always match. */
export function secretEquals(a: string, b: string): boolean {
  return timingSafeEqual(sha256(a), sha256(b));
}

/**
 * What a frame origin serves, and which origin a frame gets
 * (`docs/specs/pocket-app.md` -> "Frame origin"). Shared by the Client that
 * mints the origin and by the worker and Hosted's handler that serve it. Names
 * nothing of protocol-v1: Hosted reads this and never a frame's traffic.
 */

import { lengthPrefixedConcat, utf8Encode } from '../security/bytes.js';
import { getWebCrypto, type WebCryptoLike } from '../security/webcrypto.js';

export * from './frame-origin-paths.js';

const FRAME_ORIGIN_DOMAIN = 'dormouse/frame-origin/v1';
/** A DNS label's worth of a SHA-256: 128 bits of hex, lowercase as a host is. */
const LABEL_BYTES = 16;

export interface FrameOriginScope {
  /** The frame origin's parent domain, which only Hosted's deployment names. */
  domain: string;
  /** This device's own secret, so the host names no page and no two phones share one. */
  salt: Uint8Array;
  burrowId: string;
  surfaceId: string;
  /** The page's own origin: another page is another storage. */
  pageOrigin: string;
}

/**
 * The origin `scope`'s frame loads at: one per Surface and page, as a local
 * pane's grant is, and the same one each time, so a reload keeps the page's
 * storage and a phone does not gather a new origin per open.
 */
export async function frameOriginFor(
  scope: FrameOriginScope,
  crypto: WebCryptoLike = getWebCrypto(),
): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    lengthPrefixedConcat([
      utf8Encode(FRAME_ORIGIN_DOMAIN),
      scope.salt,
      utf8Encode(scope.burrowId),
      utf8Encode(scope.surfaceId),
      utf8Encode(scope.pageOrigin),
    ]),
  );
  const label = Array.from(new Uint8Array(digest).subarray(0, LABEL_BYTES), (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `https://${label}.${scope.domain}`;
}

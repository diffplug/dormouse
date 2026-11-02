import * as zlib from 'zlib';

/** What undoes a response's `Content-Encoding`, or `null` for one this leaves as it is. */
export function decoderFor(encoding: string): zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null {
  switch (encoding) {
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      return null;
  }
}

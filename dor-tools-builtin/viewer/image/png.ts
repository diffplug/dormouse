/** A PNG codec in plain TypeScript, so a save keeps every pixel's straight
 * (unpremultiplied) RGBA exactly and the source's color metadata verbatim,
 * which a round trip through a 2D canvas does not
 * (docs/specs/dor-tools-builtin.md -> Image editor). It decodes every
 * standard PNG; 16-bit samples round to 8 bits. It encodes 8-bit RGB, or RGBA
 * when any pixel is not opaque. No DOM, so Node tests load it. */
import { ascii, isPng, latin1, PNG_SIGNATURE } from '../../src/image-format';
import { exifFields } from '../../src/image-resolution';
import { isOpaque, orient, type Raster } from './pixels';
import { cicpSpace, iccSpace, rgbProfile, type SaveNote, type SourceColor } from './icc';

type Bytes = Uint8Array<ArrayBuffer>;
/** The ancillary chunks a save keeps; an `iCCP` only with an RGB profile. */
const KEPT = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'pHYs']);
/** Past this many pixels the codec declines, as a canvas would. */
const MAX_PIXELS = 1 << 27;
/** Samples per pixel, by color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
/** Adam7's passes: first row, first column, row step, column step. */
const ADAM7 = [[0, 0, 8, 8], [0, 4, 8, 8], [4, 0, 8, 4], [0, 2, 4, 4], [2, 0, 4, 2], [0, 1, 2, 2], [1, 0, 2, 1]];
/** The compressor's input slice: small enough that compressing never holds the page for long. */
const DEFLATE_SLICE = 1 << 20;

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
/** The CRC-32 of `b`, continuing one whose running value (before the final inversion) is `c`. */
function crcUpdate(c: number, b: Uint8Array): number {
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return c;
}
const crc32 = (b: Uint8Array) => ~crcUpdate(~0, b) >>> 0;

interface Chunk { type: string; data: Uint8Array; /** length, type, data, and CRC, as stored */ raw: Uint8Array }

/** `bytes`' chunks through IEND, each CRC checked. */
function readChunks(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) throw new Error('Not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks: Chunk[] = [];
  for (let at = 8; ;) {
    if (at + 12 > bytes.length) throw new Error('The PNG ends early.');
    const length = view.getUint32(at), end = at + 12 + length;
    if (end > bytes.length) throw new Error('The PNG ends early.');
    const type = ascii(bytes, at + 4, at + 8);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error(`The PNG's ${type} chunk is corrupt.`);
    chunks.push({ type, data: bytes.subarray(at + 8, end - 4), raw: bytes.subarray(at, end) });
    if (type === 'IEND') return chunks;
    at = end;
  }
}

/** The zlib stream `parts` hold, inflated: exactly `size` bytes when `exact`,
 * else at most `size`. The output grows only for an inexact size. */
async function inflate(parts: readonly Uint8Array[], size: number, exact: boolean): Promise<Bytes> {
  const stream = new DecompressionStream('deflate'), writer = stream.writable.getWriter();
  const writing = (async () => { for (const part of parts) await writer.write(part as Bytes); await writer.close(); })();
  writing.catch(() => {}); // the reader sees the same failure
  const reader = stream.readable.getReader();
  let out = new Uint8Array(exact ? size : Math.min(size, 1 << 16)), n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (n + value.length > size) { void reader.cancel(); throw new Error('The PNG holds more data than its size.'); }
    if (n + value.length > out.length) {
      const grown = new Uint8Array(Math.min(size, Math.max(out.length * 2, n + value.length)));
      grown.set(out.subarray(0, n));
      out = grown;
    }
    out.set(value, n);
    n += value.length;
  }
  if (exact && n !== size) throw new Error('The PNG ends early.');
  return exact ? out : out.subarray(0, n);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses filter `f` on the scanline `src` into `cur`, given the row above
 * (`prev`, zeros for the first) and `bpp` bytes per pixel. A `Uint8Array`
 * wraps each sum; the first pixel has no left neighbor, so each loop splits it out. */
function unfilterRow(f: number, src: Uint8Array, cur: Uint8Array, prev: Uint8Array, bpp: number): void {
  const n = cur.length;
  switch (f) {
    case 0: cur.set(src); return;
    case 1:
      for (let i = 0; i < bpp; i++) cur[i] = src[i];
      for (let i = bpp; i < n; i++) cur[i] = src[i] + cur[i - bpp];
      return;
    case 2:
      for (let i = 0; i < n; i++) cur[i] = src[i] + prev[i];
      return;
    case 3:
      for (let i = 0; i < bpp; i++) cur[i] = src[i] + (prev[i] >> 1);
      for (let i = bpp; i < n; i++) cur[i] = src[i] + ((cur[i - bpp] + prev[i]) >> 1);
      return;
    case 4:
      for (let i = 0; i < bpp; i++) cur[i] = src[i] + prev[i];
      for (let i = bpp; i < n; i++) cur[i] = src[i] + paeth(cur[i - bpp], prev[i], prev[i - bpp]);
      return;
    default: throw new Error('The PNG has an unknown filter.');
  }
}

/** Writes filter `f` of the scanline `cur` (row above `prev`) into `out` and
 * returns its score, the sum of its bytes read as signed, stopping once it
 * reaches `limit`. */
function filterRow(f: number, cur: Uint8Array, prev: Uint8Array, bpp: number, out: Uint8Array, limit: number): number {
  const n = cur.length;
  let score = 0, i = 0, v = 0;
  switch (f) {
    case 0:
      for (; i < n && score < limit; i++) { v = out[i] = cur[i]; score += v < 128 ? v : 256 - v; }
      return score;
    case 1:
      for (; i < bpp; i++) { v = out[i] = cur[i]; score += v < 128 ? v : 256 - v; }
      for (; i < n && score < limit; i++) { v = (cur[i] - cur[i - bpp]) & 255; out[i] = v; score += v < 128 ? v : 256 - v; }
      return score;
    case 2:
      for (; i < n && score < limit; i++) { v = (cur[i] - prev[i]) & 255; out[i] = v; score += v < 128 ? v : 256 - v; }
      return score;
    case 3:
      for (; i < bpp; i++) { v = (cur[i] - (prev[i] >> 1)) & 255; out[i] = v; score += v < 128 ? v : 256 - v; }
      for (; i < n && score < limit; i++) { v = (cur[i] - ((cur[i - bpp] + prev[i]) >> 1)) & 255; out[i] = v; score += v < 128 ? v : 256 - v; }
      return score;
    default:
      for (; i < bpp; i++) { v = (cur[i] - prev[i]) & 255; out[i] = v; score += v < 128 ? v : 256 - v; }
      for (; i < n && score < limit; i++) { v = (cur[i] - paeth(cur[i - bpp], prev[i], prev[i - bpp])) & 255; out[i] = v; score += v < 128 ? v : 256 - v; }
      return score;
  }
}

/** The unfiltered 8-bit scanline `row` of color type 0, 2, 3, or 4 as RGBA at
 * `out[o]`. Gray and palette indices go through `lut` (RGBA per index, of
 * which the first `entries` exist); `key` is the color that marks a pixel
 * transparent. */
function expandRow(colorType: number, row: Uint8Array, out: Uint8Array, o: number, lut: Uint8Array | null, entries: number, key: number[] | null): void {
  switch (colorType) {
    case 2:
      for (let i = 0; i < row.length; i += 3, o += 4) {
        const r = row[i], g = row[i + 1], b = row[i + 2];
        out[o] = r; out[o + 1] = g; out[o + 2] = b;
        out[o + 3] = key && r === key[0] && g === key[1] && b === key[2] ? 0 : 255;
      }
      return;
    case 4:
      for (let i = 0; i < row.length; i += 2, o += 4) { out[o] = out[o + 1] = out[o + 2] = row[i]; out[o + 3] = row[i + 1]; }
      return;
    default:
      for (let x = 0; x < row.length; x++, o += 4) {
        if (row[x] >= entries) throw new Error('The PNG uses a color its palette lacks.');
        const e = row[x] * 4;
        out[o] = lut![e]; out[o + 1] = lut![e + 1]; out[o + 2] = lut![e + 2]; out[o + 3] = lut![e + 3];
      }
  }
}

/** A PNG's pixels, upright by its `eXIf` orientation, and its color: the
 * chunks a save keeps, its RGB ICC profile inflated. */
export interface DecodedPng extends SourceColor { raster: Raster }

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  const chunks = readChunks(bytes), ihdr = chunks[0];
  if (ihdr?.type !== 'IHDR' || ihdr.data.length !== 13) throw new Error('The PNG has no header.');
  const h = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  const width = h.getUint32(0), height = h.getUint32(4), [depth, colorType, compression, filterMethod, interlace] = ihdr.data.subarray(8);
  const channels = CHANNELS[colorType];
  if (!DEPTHS[colorType]?.includes(depth) || compression || filterMethod || interlace > 1) throw new Error('The PNG has an unknown format.');
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('The PNG is too large to edit.');

  const find = (type: string) => chunks.find(c => c.type === type)?.data;
  const plte = find('PLTE'), trns = find('tRNS'), cicp = find('cICP'), iccp = find('iCCP'), exif = find('eXIf');
  if (colorType === 3 && !plte) throw new Error('The PNG has no palette.');
  const notes: SaveNote[] = depth === 16 ? [{ kind: 'depth16' }] : [];
  let profile: Uint8Array | undefined;
  if (iccp) {
    const rgb = rgbProfile(await inflate([iccp.subarray(iccp.indexOf(0) + 2)], 64 << 20, false).catch(() => null));
    if ('profile' in rgb) profile = rgb.profile;
    else notes.push(rgb.dropped);
  }
  // A space no canvas offers shows as sRGB; the saved pixels and profile stay exact.
  const space: PredefinedColorSpace = cicp ? cicpSpace(cicp) : profile ? iccSpace(profile) : 'srgb';

  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]], bits = channels * depth, bpp = Math.max(1, bits >> 3);
  const sizes = passes.map(([r0, c0, dr, dc]) => {
    const w = width > c0 ? Math.ceil((width - c0) / dc) : 0, rows = height > r0 ? Math.ceil((height - r0) / dr) : 0;
    return { w, rows: w ? rows : 0, rowBytes: Math.ceil((w * bits) / 8) };
  });
  const raw = await inflate(chunks.filter(c => c.type === 'IDAT').map(c => c.data), sizes.reduce((n, s) => n + s.rows * (1 + s.rowBytes), 0), true);
  const out = new Uint8Array(width * height * 4);
  const key = trns && (colorType === 0 || colorType === 2)
    ? Array.from({ length: channels }, (_, i) => (trns[2 * i] << 8) | trns[2 * i + 1]) : null;

  if (!interlace && depth === 8) {
    // Row by row, straight into the RGBA output.
    const rowBytes = sizes[0].rowBytes;
    let prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
    const entries = colorType === 3 ? Math.min(256, Math.floor(plte!.length / 3)) : 256;
    const lut = colorType === 3 || colorType === 0 ? new Uint8Array(256 * 4) : null;
    for (let e = 0; lut && e < entries; e++) {
      lut.set(colorType === 3 ? [plte![3 * e], plte![3 * e + 1], plte![3 * e + 2], trns && e < trns.length ? trns[e] : 255]
        : [e, e, e, key && key[0] === e ? 0 : 255], e * 4);
    }
    for (let y = 0, at = 0; y < height; y++, at += rowBytes + 1) {
      if (colorType === 6) {
        // RGBA rows are the output's own: unfilter in place.
        const o = y * rowBytes;
        unfilterRow(raw[at], raw.subarray(at + 1, at + 1 + rowBytes), out.subarray(o, o + rowBytes), y ? out.subarray(o - rowBytes, o) : prev, 4);
        continue;
      }
      unfilterRow(raw[at], raw.subarray(at + 1, at + 1 + rowBytes), cur, prev, bpp);
      expandRow(colorType, cur, out, y * width * 4, lut, entries, key);
      [prev, cur] = [cur, prev];
    }
  } else {
    const max = (1 << depth) - 1, to8 = depth === 16 ? (v: number) => Math.round(v / 257) : (v: number) => (v * 255) / max;
    let at = 0;
    passes.forEach(([r0, c0, dr, dc], p) => {
      const { w, rows, rowBytes } = sizes[p];
      if (!rows) return;
      const buf = new Uint8Array(rows * rowBytes), zero = new Uint8Array(rowBytes);
      for (let y = 0; y < rows; y++, at += rowBytes + 1) {
        const o = y * rowBytes;
        unfilterRow(raw[at], raw.subarray(at + 1, at + 1 + rowBytes), buf.subarray(o, o + rowBytes), y ? buf.subarray(o - rowBytes, o) : zero, bpp);
      }
      const s = new Array<number>(channels);
      for (let y = 0; y < rows; y++) {
        const row = y * rowBytes;
        for (let x = 0; x < w; x++) {
          for (let ch = 0; ch < channels; ch++) {
            const i = x * channels + ch;
            s[ch] = depth === 8 ? buf[row + i]
              : depth === 16 ? (buf[row + 2 * i] << 8) | buf[row + 2 * i + 1]
              : (buf[row + ((i * depth) >> 3)] >> (8 - depth - ((i * depth) & 7))) & max;
          }
          const o = ((r0 + y * dr) * width + c0 + x * dc) * 4;
          if (colorType === 3) {
            const e = s[0];
            if (3 * e + 2 >= plte!.length) throw new Error('The PNG uses a color its palette lacks.');
            out[o] = plte![3 * e]; out[o + 1] = plte![3 * e + 1]; out[o + 2] = plte![3 * e + 2];
            out[o + 3] = trns && e < trns.length ? trns[e] : 255;
            continue;
          }
          const gray = channels < 3;
          out[o] = to8(s[0]); out[o + 1] = to8(gray ? s[0] : s[1]); out[o + 2] = to8(gray ? s[0] : s[2]);
          out[o + 3] = colorType === 4 ? to8(s[1]) : colorType === 6 ? to8(s[3]) : key && key.every((k, c) => k === s[c]) ? 0 : 255;
        }
      }
    });
  }
  const keep = chunks.filter(c => KEPT.has(c.type) && (c.type !== 'iCCP' || profile)).map(c => c.raw.slice());
  // Upright, as a browser shows it; a save then drops the eXIf.
  const raster = orient({ width, height, data: new Uint8ClampedArray(out.buffer) }, exif ? exifFields(exif).orientation : 1);
  return { raster, space, keep, profile, notes };
}

function chunk(type: string, data: Uint8Array): Bytes {
  const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(latin1(type), 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** An `iCCP` chunk carrying `profile`, for a save whose source held the
 * profile some other way. */
export async function iccpChunk(profile: Uint8Array): Promise<Bytes> {
  const compressed = await new Response(new Blob([profile as Bytes]).stream().pipeThrough(new CompressionStream('deflate'))).arrayBuffer();
  const data = new Uint8Array(13 + compressed.byteLength);
  // The profile's name, its terminator, then compression method 0.
  data.set(latin1('ICC profile'));
  data.set(new Uint8Array(compressed), 13);
  return chunk('iCCP', data);
}

/** `r` as a PNG's parts, in order, with `keep` (whole chunks from a decoded
 * source) after its header. Reads every pixel before it returns, so the
 * caller may change `r` while the bytes are compressed. */
export function encodePng(r: Raster, keep: readonly Uint8Array[] = []): Promise<Bytes[]> {
  const { width, height, data } = r;
  if (!width || !height) throw new Error('An empty image cannot be saved.');
  const opaque = isOpaque(r), channels = opaque ? 3 : 4, rowBytes = width * channels, stride = rowBytes + 1;
  const filtered = new Uint8Array(height * stride);
  let prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
  let trial = new Uint8Array(rowBytes), best = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    if (opaque) for (let x = 0, i = y * width * 4, o = 0; x < width; x++, i += 4, o += 3) { cur[o] = data[i]; cur[o + 1] = data[i + 1]; cur[o + 2] = data[i + 2]; }
    else cur.set(data.subarray(y * width * 4, (y + 1) * width * 4));
    // Each row takes the filter whose output bytes, read as signed, sum smallest.
    let bestFilter = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      const score = filterRow(f, cur, prev, channels, trial, bestScore);
      if (score < bestScore) { bestScore = score; bestFilter = f; [trial, best] = [best, trial]; }
    }
    filtered[y * stride] = bestFilter;
    filtered.set(best, y * stride + 1);
    [prev, cur] = [cur, prev];
  }
  const ihdr = new Uint8Array(13), h = new DataView(ihdr.buffer);
  h.setUint32(0, width); h.setUint32(4, height); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  const head = [new Uint8Array(PNG_SIGNATURE), chunk('IHDR', ihdr), ...keep.map(k => k as Bytes)];
  return idat(filtered).then(parts => [...head, ...parts, chunk('IEND', new Uint8Array(0))]);
}

/** The IDAT chunk holding `filtered` compressed, as parts: its header, the
 * compressor's output as it came, and the CRC. */
async function idat(filtered: Uint8Array): Promise<Bytes[]> {
  const stream = new CompressionStream('deflate'), writer = stream.writable.getWriter();
  const writing = (async () => {
    for (let at = 0; at < filtered.length; at += DEFLATE_SLICE) await writer.write(filtered.subarray(at, at + DEFLATE_SLICE) as Bytes);
    await writer.close();
  })();
  writing.catch(() => {}); // the reader sees the same failure
  const reader = stream.readable.getReader(), parts: Bytes[] = [];
  const type = latin1('IDAT');
  let crc = crcUpdate(~0, type), length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    parts.push(value);
    crc = crcUpdate(crc, value);
    length += value.length;
  }
  const header = new Uint8Array(8), end = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, length);
  header.set(type, 4);
  new DataView(end.buffer).setUint32(0, ~crc >>> 0);
  return [header, ...parts, end];
}

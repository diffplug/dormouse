/** A PNG codec in plain TypeScript, so a save keeps every pixel's straight
 * (unpremultiplied) RGBA exactly and the source's color metadata verbatim,
 * which a round trip through a 2D canvas does not
 * (docs/specs/dor-tools-builtin.md -> Image editor). It decodes every
 * standard PNG; 16-bit samples round to 8 bits. It encodes 8-bit RGB, or RGBA
 * when any pixel is not opaque. No DOM, so Node tests load it. */
import type { Raster } from './pixels';
import { cicpSpace, iccSpace, type SourceSpace } from './icc';

export interface DecodedPng {
  raster: Raster;
  space: SourceSpace;
  /** The source's chunks a save copies verbatim: color metadata and pixel density. */
  keep: Uint8Array[];
  /** Why the saved file will differ from the source beyond the edits. */
  note?: string;
}

type Bytes = Uint8Array<ArrayBuffer>;
const SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
/** The ancillary chunks a save keeps. */
const KEPT = new Set(['iCCP', 'sRGB', 'gAMA', 'cHRM', 'cICP', 'pHYs']);
/** Past this many pixels the codec declines, as a canvas would. */
const MAX_PIXELS = 1 << 27;
/** Samples per pixel, by color type. */
const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };
const DEPTHS: Record<number, number[]> = { 0: [1, 2, 4, 8, 16], 2: [8, 16], 3: [1, 2, 4, 8], 4: [8, 16], 6: [8, 16] };
/** Adam7's passes: first row, first column, row step, column step. */
const ADAM7 = [[0, 0, 8, 8], [0, 4, 8, 8], [4, 0, 8, 4], [0, 2, 4, 4], [2, 0, 4, 2], [0, 1, 2, 2], [1, 0, 2, 1]];

export const isPng = (b: Uint8Array) => SIGNATURE.every((byte, i) => b[i] === byte);

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  for (let k = 0; k < 8; k++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1;
  return n;
});
export function crc32(b: Uint8Array): number {
  let c = ~0;
  for (let i = 0; i < b.length; i++) c = CRC_TABLE[(c ^ b[i]) & 255] ^ (c >>> 8);
  return ~c >>> 0;
}

export interface Chunk { type: string; data: Uint8Array; /** length, type, data, and CRC, as stored */ raw: Uint8Array }

/** `bytes`' chunks through IEND, each CRC checked. */
export function readChunks(bytes: Uint8Array): Chunk[] {
  if (!isPng(bytes)) throw new Error('Not a PNG.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength), chunks: Chunk[] = [];
  for (let at = 8; ;) {
    if (at + 12 > bytes.length) throw new Error('The PNG ends early.');
    const length = view.getUint32(at), end = at + 12 + length;
    if (end > bytes.length) throw new Error('The PNG ends early.');
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    if (crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error(`The PNG's ${type} chunk is corrupt.`);
    chunks.push({ type, data: bytes.subarray(at + 8, end - 4), raw: bytes.subarray(at, end) });
    if (type === 'IEND') return chunks;
    at = end;
  }
}

const stream = (data: Uint8Array) => new Blob([data as Bytes]).stream();
const concat = (parts: readonly Uint8Array[]): Bytes => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
};

/** zlib-inflated `data`, refusing more than `limit` bytes. */
export async function inflate(data: Uint8Array, limit: number): Promise<Bytes> {
  const reader = stream(data).pipeThrough(new DecompressionStream('deflate')).getReader(), parts: Uint8Array[] = [];
  for (let n = 0; ;) {
    const { done, value } = await reader.read();
    if (done) return concat(parts);
    if ((n += value.length) > limit) { void reader.cancel(); throw new Error('The PNG holds more data than its size.'); }
    parts.push(value);
  }
}
const deflate = async (data: Uint8Array): Promise<Bytes> =>
  new Uint8Array(await new Response(stream(data).pipeThrough(new CompressionStream('deflate'))).arrayBuffer());

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** Reverses `rows` filtered scanlines of `rowBytes` from `src` at `at` into
 * `out` (which may be clamped, so every sum wraps explicitly); returns where they end. */
function unfilter(src: Uint8Array, at: number, rows: number, rowBytes: number, bpp: number, out: Uint8Array | Uint8ClampedArray): number {
  for (let y = 0; y < rows; y++) {
    const filter = src[at++], o = y * rowBytes, p = o - rowBytes;
    for (let i = 0; i < rowBytes; i++) {
      const a = i >= bpp ? out[o + i - bpp] : 0, b = y ? out[p + i] : 0, c = y && i >= bpp ? out[p + i - bpp] : 0;
      const pred = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? paeth(a, b, c) : -1;
      if (pred < 0) throw new Error('The PNG has an unknown filter.');
      out[o + i] = (src[at + i] + pred) & 255;
    }
    at += rowBytes;
  }
  return at;
}

export async function decodePng(bytes: Uint8Array): Promise<DecodedPng> {
  const chunks = readChunks(bytes), ihdr = chunks[0];
  if (ihdr?.type !== 'IHDR' || ihdr.data.length !== 13) throw new Error('The PNG has no header.');
  const h = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, 13);
  const width = h.getUint32(0), height = h.getUint32(4), [depth, colorType, compression, filterMethod, interlace] = ihdr.data.subarray(8);
  const channels = CHANNELS[colorType];
  if (!DEPTHS[colorType]?.includes(depth) || compression || filterMethod || interlace > 1) throw new Error('The PNG has an unknown format.');
  if (!width || !height || width * height > MAX_PIXELS) throw new Error('The PNG is too large to edit.');

  const find = (type: string) => chunks.find(c => c.type === type)?.data;
  const plte = find('PLTE'), trns = find('tRNS'), cicp = find('cICP'), iccp = find('iCCP');
  if (colorType === 3 && !plte) throw new Error('The PNG has no palette.');
  let space: SourceSpace = cicp ? cicpSpace(cicp) : null;
  if (!cicp && iccp) {
    const nul = iccp.indexOf(0);
    space = await inflate(iccp.subarray(nul + 2), 64 << 20).then(iccSpace, () => null);
  }
  if (!cicp && !iccp) space = 'srgb';

  const passes = interlace ? ADAM7 : [[0, 0, 1, 1]], bits = channels * depth, bpp = Math.max(1, bits >> 3);
  const sizes = passes.map(([r0, c0, dr, dc]) => {
    const w = width > c0 ? Math.ceil((width - c0) / dc) : 0, rows = height > r0 ? Math.ceil((height - r0) / dr) : 0;
    return { w, rows: w ? rows : 0, rowBytes: Math.ceil((w * bits) / 8) };
  });
  const total = sizes.reduce((n, s) => n + s.rows * (1 + s.rowBytes), 0);
  const raw = await inflate(concat(chunks.filter(c => c.type === 'IDAT').map(c => c.data)), total);
  if (raw.length !== total) throw new Error('The PNG ends early.');

  const data = new Uint8ClampedArray(width * height * 4);
  if (!interlace && depth === 8 && colorType === 6) unfilter(raw, 0, height, width * 4, 4, data);
  else {
    const max = (1 << depth) - 1, to8 = depth === 16 ? (v: number) => Math.round(v / 257) : (v: number) => (v * 255) / max;
    const key = trns && (colorType === 0 || colorType === 2)
      ? Array.from({ length: channels }, (_, i) => (trns[2 * i] << 8) | trns[2 * i + 1]) : null;
    let at = 0;
    passes.forEach(([r0, c0, dr, dc], p) => {
      const { w, rows, rowBytes } = sizes[p];
      if (!rows) return;
      const buf = new Uint8Array(rows * rowBytes);
      at = unfilter(raw, at, rows, rowBytes, bpp, buf);
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
            data[o] = plte![3 * e]; data[o + 1] = plte![3 * e + 1]; data[o + 2] = plte![3 * e + 2];
            data[o + 3] = trns && e < trns.length ? trns[e] : 255;
            continue;
          }
          const gray = channels < 3;
          data[o] = to8(s[0]); data[o + 1] = to8(gray ? s[0] : s[1]); data[o + 2] = to8(gray ? s[0] : s[2]);
          data[o + 3] = colorType === 4 ? to8(s[1]) : colorType === 6 ? to8(s[3]) : key && key.every((k, c) => k === s[c]) ? 0 : 255;
        }
      }
    });
  }
  const keep = chunks.filter(c => KEPT.has(c.type)).map(c => c.raw.slice());
  return { raster: { width, height, data }, space, keep, note: depth === 16 ? 'This 16-bit PNG saves at 8 bits per channel.' : undefined };
}

function chunk(type: string, data: Uint8Array): Bytes {
  const out = new Uint8Array(data.length + 12), view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** `r` as a PNG, with `keep` (whole chunks from a decoded source) after its header. */
export async function encodePng(r: Raster, keep: readonly Uint8Array[] = []): Promise<Bytes> {
  const { width, height, data } = r;
  if (!width || !height) throw new Error('An empty image cannot be saved.');
  let opaque = true;
  for (let i = 3; i < data.length && opaque; i += 4) opaque = data[i] === 255;
  const channels = opaque ? 3 : 4, rowBytes = width * channels;
  const out = new Uint8Array(height * (rowBytes + 1));
  let prev = new Uint8Array(rowBytes), cur = new Uint8Array(rowBytes);
  const trial = new Uint8Array(rowBytes), best = new Uint8Array(rowBytes);
  for (let y = 0; y < height; y++) {
    for (let x = 0, i = y * width * 4, o = 0; x < width; x++, i += 4) {
      cur[o++] = data[i]; cur[o++] = data[i + 1]; cur[o++] = data[i + 2];
      if (!opaque) cur[o++] = data[i + 3];
    }
    // Each row takes the filter whose output bytes, read as signed, sum smallest.
    let bestFilter = 0, bestScore = Infinity;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      for (let i = 0; i < rowBytes && score < bestScore; i++) {
        const a = i >= channels ? cur[i - channels] : 0, b = prev[i], c = i >= channels ? prev[i - channels] : 0;
        const v = (cur[i] - (f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c))) & 255;
        trial[i] = v;
        score += v < 128 ? v : 256 - v;
      }
      if (score < bestScore) { bestScore = score; bestFilter = f; best.set(trial); }
    }
    out[y * (rowBytes + 1)] = bestFilter;
    out.set(best, y * (rowBytes + 1) + 1);
    [prev, cur] = [cur, prev];
  }
  const ihdr = new Uint8Array(13), h = new DataView(ihdr.buffer);
  h.setUint32(0, width); h.setUint32(4, height); ihdr[8] = 8; ihdr[9] = opaque ? 2 : 6;
  return concat([new Uint8Array(SIGNATURE), chunk('IHDR', ihdr), ...keep, chunk('IDAT', await deflate(out)), chunk('IEND', new Uint8Array(0))]);
}

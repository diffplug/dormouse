import assert from 'node:assert/strict';
import { test } from 'node:test';
import { crc32 as zlibCrc32, deflateSync, inflateSync } from 'node:zlib';
import { imageEditability, jpegSize, MAX_EDIT_PIXELS, pngSize } from '../dist/image-editability.js';
import { IMAGE_BOUND } from '../dist/image-format.js';
import { imageResolution } from '../dist/image-resolution.js';
import { chunk, load, tiff } from './bundle.mjs';

const png = await load('../viewer/image/png.ts');
const jpeg = await load('../viewer/image/jpeg.ts');
const { cicpSpace, iccSpace } = await load('../viewer/image/icc.ts');
const { over, decodeImage, encodeImage, asSaved, describe, saveType } = await load('../viewer/image/io.ts');
/** `r` as PNG bytes, its parts joined. */
const encode = async (r, keep) => new Uint8Array(Buffer.concat(await png.encodePng(r, keep)));
/** `spliceIcc`'s parts, joined. */
const splice = (encoded, icc, dpi) => new Uint8Array(Buffer.concat(jpeg.spliceIcc(encoded, icc, dpi)));

// PNGs built here with Node's zlib and CRC, independently of the codec under test.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function ihdr(width, height, depth, colorType, interlace = 0) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4);
  b[8] = depth; b[9] = colorType; b[12] = interlace;
  return chunk('IHDR', b);
}
/** A PNG whose scanlines (each without its filter byte) are `rows`, all
 * filter None, or each filtered by `filters(y)` with `bpp` bytes per pixel. */
function makePng(width, height, depth, colorType, rows, extra = [], { filters = () => 0, bpp = 1 } = {}) {
  const raw = Buffer.concat(rows.map((r, y) => filterRow(filters(y), r, rows[y - 1], bpp)));
  return new Uint8Array(Buffer.concat([SIGNATURE, ihdr(width, height, depth, colorType), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', [])]));
}
/** PNG filter `f` of `row` (the row above `up`), with its filter byte: the
 * spec's definitions, written independently of the codec under test. */
function filterRow(f, row, up = [], bpp = 1) {
  const a = i => i >= bpp ? row[i - bpp] : 0, b = i => up[i] ?? 0, c = i => i >= bpp ? up[i - bpp] ?? 0 : 0;
  const paeth = i => {
    const p = a(i) + b(i) - c(i), pa = Math.abs(p - a(i)), pb = Math.abs(p - b(i)), pc = Math.abs(p - c(i));
    return pa <= pb && pa <= pc ? a(i) : pb <= pc ? b(i) : c(i);
  };
  const predict = [() => 0, a, b, i => (a(i) + b(i)) >> 1, paeth][f];
  return Buffer.from([f, ...row.map((v, i) => (v - predict(i)) & 255)]);
}
/** Every chunk of `bytes`, each CRC checked against Node's. */
function chunks(bytes) {
  const b = Buffer.from(bytes), out = [];
  assert.deepEqual(b.subarray(0, 8), SIGNATURE);
  for (let at = 8; at < b.length;) {
    const length = b.readUInt32BE(at), type = b.toString('latin1', at + 4, at + 8);
    assert.equal(b.readUInt32BE(at + 8 + length), zlibCrc32(b.subarray(at + 4, at + 8 + length)), `${type} CRC`);
    out.push({ type, data: b.subarray(at + 8, at + 8 + length), raw: b.subarray(at, at + 12 + length) });
    at += 12 + length;
  }
  return out;
}
const pixels = r => Array.from({ length: r.width * r.height }, (_, i) => Array.from(r.data.subarray(i * 4, i * 4 + 4)));

/** An ICC profile holding just a description tag (v2 `desc` or v4 `mluc`) or
 * colorants, for data color space `space`. */
function icc({ desc, mluc, colorants, space = 'RGB ' }) {
  const tags = [];
  if (desc) {
    const t = Buffer.alloc(12 + desc.length + 1);
    t.write('desc', 0, 'latin1'); t.writeUInt32BE(desc.length + 1, 8); t.write(desc, 12, 'latin1');
    tags.push(['desc', t]);
  }
  if (mluc) {
    const text = Buffer.from(mluc, 'utf16le').swap16(), t = Buffer.alloc(28 + text.length);
    t.write('mluc', 0, 'latin1'); t.writeUInt32BE(1, 8); t.writeUInt32BE(12, 12);
    t.write('enUS', 16, 'latin1'); t.writeUInt32BE(text.length, 20); t.writeUInt32BE(28, 24); text.copy(t, 28);
    tags.push(['desc', t]);
  }
  if (colorants) ['rXYZ', 'gXYZ', 'bXYZ'].forEach((sig, i) => {
    const t = Buffer.alloc(20);
    t.write('XYZ ', 0, 'latin1');
    colorants.slice(i * 3, i * 3 + 3).forEach((v, j) => t.writeInt32BE(Math.round(v * 65536), 8 + 4 * j));
    tags.push([sig, t]);
  });
  const header = Buffer.alloc(132 + 12 * tags.length);
  header.write(space, 16, 'latin1');
  header.write('acsp', 36, 'latin1');
  header.writeUInt32BE(tags.length, 128);
  let offset = header.length;
  tags.forEach(([sig, t], i) => {
    header.write(sig, 132 + 12 * i, 'latin1'); header.writeUInt32BE(offset, 136 + 12 * i); header.writeUInt32BE(t.length, 140 + 12 * i);
    offset += t.length;
  });
  const profile = Buffer.concat([header, ...tags.map(([, t]) => t)]);
  profile.writeUInt32BE(profile.length, 0);
  return profile;
}
const iccp = profile => chunk('iCCP', Buffer.concat([Buffer.from('ICC Profile\0\0', 'latin1'), deflateSync(profile)]));

test('an RGBA raster with every alpha round-trips exactly, as RGBA with valid CRCs', async () => {
  const width = 37, height = 29, data = new Uint8ClampedArray(width * height * 4);
  let seed = 7;
  for (let i = 0; i < data.length; i++) data[i] = (seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16;
  for (let p = 0; p < width * height; p++) data[p * 4 + 3] = p % 256;
  // Smooth rows too, so Sub, Up, Average, and Paeth each win some rows.
  for (let x = 0; x < width; x++) for (const y of [3, 4, 5]) data.set([x * 3, y * 7, x + y, 1 + x], (y * width + x) * 4);
  const raster = { width, height, data };
  const bytes = await encode(raster);

  const list = chunks(bytes);
  assert.deepEqual(list.map(c => c.type), ['IHDR', 'IDAT', 'IEND']);
  assert.equal(list[0].data[9], 6, 'color type RGBA');
  const filters = new Set();
  const raw = inflateSync(list[1].data);
  for (let y = 0; y < height; y++) filters.add(raw[y * (width * 4 + 1)]);
  assert.ok(filters.size > 1, `rows choose their filters: ${[...filters]}`);

  const decoded = await png.decodePng(bytes);
  assert.deepEqual([decoded.raster.width, decoded.raster.height], [width, height]);
  assert.deepEqual(Array.from(decoded.raster.data), Array.from(data));
  assert.deepEqual(decoded.keep, []);
  assert.equal(decoded.space, 'srgb');
});

test('an opaque raster encodes as RGB and decodes back exactly', async () => {
  const raster = { width: 3, height: 2, data: new Uint8ClampedArray([1, 2, 3, 255, 250, 128, 0, 255, 9, 9, 9, 255, 0, 0, 0, 255, 255, 255, 255, 255, 40, 50, 60, 255]) };
  const bytes = await encode(raster);
  assert.equal(chunks(bytes)[0].data[9], 2, 'color type RGB');
  assert.deepEqual(Array.from((await png.decodePng(bytes)).raster.data), Array.from(raster.data));
});

test('the decoder checks CRCs', async () => {
  const bytes = await encode({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) });
  bytes[bytes.length - 20] ^= 1; // inside IDAT's data
  await assert.rejects(png.decodePng(bytes), /corrupt/);
});

test('a palette with a shorter tRNS decodes, sub-byte indices included', async () => {
  const plte = chunk('PLTE', [255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30]);
  const trns = chunk('tRNS', [0, 128]);
  // 2-bit indices, 5 to a row: 0 1 2 3 0 / 3 2 1 0 1
  const r = await png.decodePng(makePng(5, 2, 2, 3, [[0b00011011, 0b00000000], [0b11100100, 0b01000000]], [plte, trns]));
  assert.deepEqual(pixels(r.raster), [
    [255, 0, 0, 0], [0, 255, 0, 128], [0, 0, 255, 255], [10, 20, 30, 255], [255, 0, 0, 0],
    [10, 20, 30, 255], [0, 0, 255, 255], [0, 255, 0, 128], [255, 0, 0, 0], [0, 255, 0, 128],
  ]);
  const eight = await png.decodePng(makePng(2, 1, 8, 3, [[3, 1]], [plte, trns]));
  assert.deepEqual(pixels(eight.raster), [[10, 20, 30, 255], [0, 255, 0, 128]]);
});

test('gray, gray with alpha, 1-bit gray, and 16-bit gray with a color key decode', async () => {
  assert.deepEqual(pixels((await png.decodePng(makePng(2, 1, 8, 0, [[0, 200]]))).raster), [[0, 0, 0, 255], [200, 200, 200, 255]]);
  assert.deepEqual(pixels((await png.decodePng(makePng(2, 1, 8, 4, [[90, 3, 255, 254]]))).raster), [[90, 90, 90, 3], [255, 255, 255, 254]]);
  assert.deepEqual(pixels((await png.decodePng(makePng(3, 1, 1, 0, [[0b10100000]]))).raster), [[255, 255, 255, 255], [0, 0, 0, 255], [255, 255, 255, 255]]);
  const sixteen = await png.decodePng(makePng(2, 1, 16, 0, [[0x12, 0x34, 0xff, 0xff]], [chunk('tRNS', [0x12, 0x34])]));
  assert.deepEqual(pixels(sixteen.raster), [[18, 18, 18, 0], [255, 255, 255, 255]]);
  assert.deepEqual(sixteen.notes, [{ kind: 'depth16' }]);
  const rgbKey = await png.decodePng(makePng(2, 1, 8, 2, [[1, 2, 3, 1, 2, 4]], [chunk('tRNS', [0, 1, 0, 2, 0, 3])]));
  assert.deepEqual(pixels(rgbKey.raster), [[1, 2, 3, 0], [1, 2, 4, 255]]);
});

test('an Adam7-interlaced PNG decodes to the same pixels', async () => {
  const width = 11, height = 9, rgba = (x, y) => [x * 20, y * 25, (x * y) & 255, (x + y * width) % 256];
  const passes = [[0, 0, 8, 8], [0, 4, 8, 8], [4, 0, 8, 4], [0, 2, 4, 4], [2, 0, 4, 2], [0, 1, 2, 2], [1, 0, 2, 1]];
  const rows = [];
  for (const [r0, c0, dr, dc] of passes) for (let y = r0; y < height; y += dr) {
    const row = [];
    for (let x = c0; x < width; x += dc) row.push(...rgba(x, y));
    if (row.length) rows.push(row);
  }
  const raw = Buffer.concat(rows.map(r => Buffer.from([0, ...r])));
  const bytes = Buffer.concat([SIGNATURE, ihdr(width, height, 8, 6, 1), chunk('IDAT', deflateSync(raw)), chunk('IEND', [])]);
  const r = await png.decodePng(new Uint8Array(bytes));
  assert.deepEqual(pixels(r.raster), Array.from({ length: width * height }, (_, i) => rgba(i % width, Math.floor(i / width))));
});

test('color chunks and pHYs are copied verbatim; other metadata is dropped', async () => {
  const profile = icc({ desc: 'Display P3' }), color = iccp(profile);
  const cicp = chunk('cICP', [12, 13, 0, 1]), phys = chunk('pHYs', [0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1]);
  const source = makePng(2, 1, 8, 6, [[1, 2, 3, 4, 5, 6, 7, 8]], [color, cicp, phys, chunk('tEXt', Buffer.from('Comment\0hi', 'latin1'))]);
  const decoded = await png.decodePng(source);
  assert.equal(decoded.space, 'display-p3');
  const saved = chunks(await encode(decoded.raster, decoded.keep));
  assert.deepEqual(saved.map(c => c.type), ['IHDR', 'iCCP', 'cICP', 'pHYs', 'IDAT', 'IEND']);
  assert.deepEqual(saved[1].raw, color);
  assert.deepEqual(saved[2].raw, cicp);
  assert.deepEqual(saved[3].raw, phys);
  const again = await png.decodePng(new Uint8Array(Buffer.concat(saved.map(c => c.raw).flatMap((raw, i) => i ? [raw] : [SIGNATURE, raw]))));
  assert.equal(again.space, 'display-p3');
  assert.deepEqual(Array.from(again.raster.data), [1, 2, 3, 4, 5, 6, 7, 8]);
});

test('the display space comes from cICP, else the ICC description, else its primaries', async () => {
  const p3 = [0.5151, 0.2412, -0.0011, 0.2919, 0.6922, 0.0419, 0.1572, 0.0666, 0.7841];
  assert.equal(iccSpace(icc({ desc: 'Display P3' })), 'display-p3');
  assert.equal(iccSpace(icc({ mluc: 'Display P3' })), 'display-p3');
  assert.equal(iccSpace(icc({ mluc: 'sRGB IEC61966-2.1' })), 'srgb');
  assert.equal(iccSpace(icc({ desc: 'Color LCD', colorants: p3 })), 'display-p3');
  assert.equal(iccSpace(icc({ desc: 'Adobe RGB (1998)', colorants: [0.6097, 0.3111, 0.0195, 0.2053, 0.6257, 0.0609, 0.1492, 0.0632, 0.7446] })), 'srgb', 'no canvas space: shown as sRGB');
  const space = async extra => (await png.decodePng(makePng(1, 1, 8, 0, [[0]], extra))).space;
  assert.equal(await space([iccp(icc({ desc: 'sRGB' })), chunk('cICP', [12, 13, 0, 1])]), 'display-p3', 'cICP wins');
  assert.equal(await space([iccp(icc({ desc: 'Display P3' }))]), 'display-p3');
  assert.equal(await space([chunk('sRGB', [0])]), 'srgb');
});

test('compositing a layer over an area leaves the pixels it does not cover exact', () => {
  const r = { width: 4, height: 2, data: new Uint8ClampedArray(32).map((_, i) => i * 7) };
  r.data.set([10, 20, 30, 0, 200, 100, 50, 128, 1, 2, 3, 0], 16 + 4);
  // A 3×1 layer over the second row, from its second pixel.
  const out = over(r, { x: 1, y: 1, width: 3, height: 1 }, new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 102]));
  assert.deepEqual(pixels(out).slice(5), [[10, 20, 30, 0], [255, 0, 0, 255], [0, 0, 255, 102]]);
  assert.deepEqual(Array.from(out.data.subarray(0, 20)), Array.from(r.data.subarray(0, 20)), 'pixels outside the area stay exact');
  assert.deepEqual(Array.from(r.data.subarray(24, 28)), [200, 100, 50, 128], 'the source is untouched');
});

/** A 2×2 baseline JPEG (macOS sips) with APP0, Exif APP1, and Photoshop APP13, but no ICC profile. */
const JPEG = new Uint8Array(Buffer.from(
  '/9j/4AAQSkZJRgABAQAASABIAAD/4QBMRXhpZgAATU0AKgAAAAgAAYdpAAQAAAABAAAAGgAAAAAAA6ABAAMAAAABAAEAAKACAAQAAAABAAAAAqADAAQAAAAB' +
  'AAAAAgAAAAD/7QA4UGhvdG9zaG9wIDMuMAA4QklNBAQAAAAAAAA4QklNBCUAAAAAABDUHYzZjwCyBOmACZjs+EJ+/8AAEQgAAgACAwEiAAIRAQMRAf/EAB8A' +
  'AAEFAQEBAQEBAAAAAAAAAAABAgMEBQYHCAkKC//EALUQAAIBAwMCBAMFBQQEAAABfQECAwAEEQUSITFBBhNRYQcicRQygZGhCCNCscEVUtHwJDNicoIJChYX' +
  'GBkaJSYnKCkqNDU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6g4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfI' +
  'ycrS09TV1tfY2drh4uPk5ebn6Onq8fLz9PX29/j5+v/EAB8BAAMBAQEBAQEBAQEAAAAAAAABAgMEBQYHCAkKC//EALURAAIBAgQEAwQHBQQEAAECdwABAgMR' +
  'BAUhMQYSQVEHYXETIjKBCBRCkaGxwQkjM1LwFWJy0QoWJDThJfEXGBkaJicoKSo1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoKDhIWG' +
  'h4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uLj5OXm5+jp6vLz9PX29/j5+v/bAEMAAgICAgICAwICAwQDAwMEBQQE' +
  'BAQFBwUFBQUFBwgHBwcHBwcICAgICAgICAoKCgoKCgsLCwsLDQ0NDQ0NDQ0NDf/bAEMBAgICAwMDBgMDBg0JBwkNDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0N' +
  'DQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDQ0NDf/dAAQAAf/aAAwDAQACEQMRAD8A+Q6KKK/Cz/VQ/9k=', 'base64'));
/** `bytes`' markers up to the scan, each length walked; the scan's offset. */
function markers(bytes) {
  assert.deepEqual([bytes[0], bytes[1]], [0xff, 0xd8], 'starts with SOI');
  const list = [];
  for (let at = 2; ;) {
    assert.equal(bytes[at], 0xff, `a marker at ${at}`);
    const marker = bytes[at + 1];
    if (marker === 0xda) return { list, scan: at };
    const end = at + 2 + ((bytes[at + 2] << 8) | bytes[at + 3]);
    list.push({ marker, bytes: bytes.subarray(at, end) });
    at = end;
  }
}
function iccSegment(seq, count, payload) {
  const body = Buffer.concat([Buffer.from('ICC_PROFILE\0', 'latin1'), Buffer.from([seq, count]), payload]);
  return new Uint8Array(Buffer.concat([Buffer.from([0xff, 0xe2, (body.length + 2) >> 8, (body.length + 2) & 255]), body]));
}

test('a JPEG\'s ICC segments are spliced in after SOI and APP0, replacing the encoder\'s own', () => {
  const profile = icc({ desc: 'Display P3' });
  const source = splice(JPEG, [iccSegment(2, 2, profile.subarray(100)), iccSegment(1, 2, profile.subarray(0, 100))]);
  const keep = jpeg.iccSegments(source);
  assert.equal(keep.length, 2);
  assert.deepEqual(Buffer.from(jpeg.iccProfile(keep)), profile, 'rejoined by sequence number');
  assert.equal(iccSpace(jpeg.iccProfile(keep)), 'display-p3');

  // An encoder's own (sRGB) profile gives way to the source's.
  const encoded = splice(JPEG, [iccSegment(1, 1, icc({ desc: 'sRGB' }))]);
  const saved = splice(encoded, keep);
  const { list, scan } = markers(saved), original = markers(JPEG);
  assert.deepEqual(list.map(s => s.marker), [0xe0, 0xe2, 0xe2, ...original.list.slice(1).map(s => s.marker)]);
  assert.deepEqual(list.slice(1, 3).map(s => Array.from(s.bytes)), keep.map(s => Array.from(s)));
  assert.deepEqual(Buffer.from(saved.subarray(scan)), Buffer.from(JPEG.subarray(original.scan)), 'the scan and EOI are untouched');
  assert.deepEqual(splice(saved, []), JPEG, 'splicing nothing strips the profile');
});

test('the editor leaves an image view-only past its byte or pixel bound, read from the header alone', async () => {
  // Headers alone: no pixel data follows.
  const pngHeader = (width, height) => makePng(width, height, 8, 6, []);
  const side = Math.sqrt(MAX_EDIT_PIXELS);
  assert.deepEqual(pngSize(pngHeader(20000, 30)), { width: 20000, height: 30 });
  assert.deepEqual(imageEditability(100, pngHeader(side, side)), { ok: true });
  assert.match(imageEditability(100, pngHeader(side, side + 1)).viewOnly, /8192 × 8193 pixels.*64-megapixel/);
  assert.match(imageEditability(IMAGE_BOUND.limit + 1, pngHeader(1, 1)).viewOnly, /32 MiB/);
  assert.deepEqual(imageEditability(IMAGE_BOUND.limit, pngHeader(1, 1)), { ok: true });
  // The page checks again before decoding, as a backstop.
  assert.match((await decodeImage(new Blob([pngHeader(20000, 20000)]))).viewOnly, /64-megapixel/);

  const sof = markers(JPEG).list.find(s => s.marker === 0xc0), at = sof.bytes.byteOffset - JPEG.byteOffset;
  assert.deepEqual(jpegSize(JPEG), { height: (sof.bytes[5] << 8) | sof.bytes[6], width: (sof.bytes[7] << 8) | sof.bytes[8] });
  assert.equal(jpegSize(JPEG.subarray(0, at + 10)), null, 'a frame header cut short is unknown');
  const big = JPEG.slice();
  big.set([9000 >> 8, 9000 & 255, 8000 >> 8, 8000 & 255], at + 5);
  assert.match(imageEditability(big.length, big).viewOnly, /8000 × 9000/);
  assert.match((await decodeImage(new Blob([big]))).viewOnly, /64-megapixel/);

  // A frame header behind a large APP1 is found in the bytes that hold it; a
  // head that ends first, mid-segment, reads as unknown and so editable.
  const app1 = new Uint8Array(4 + 60000);
  app1.set([0xff, 0xe1, 60002 >> 8, 60002 & 255]);
  const padded = new Uint8Array(Buffer.concat([big.subarray(0, 2), app1, big.subarray(2)]));
  assert.deepEqual(jpegSize(padded), { width: 8000, height: 9000 });
  assert.equal(jpegSize(padded.subarray(0, 30000)), null);
  assert.deepEqual(imageEditability(padded.length, padded.subarray(0, 30000)), { ok: true });
});

test('8-bit gray, gray with alpha, palette, and RGB rows decode through every filter, as do 16-bit and interlaced rows', async () => {
  const width = 7, height = 10, filters = y => y % 5;
  const value = (x, y, k) => (x * 37 + y * 101 + k * 53 + ((x * y) % 7) * 29) & 255;
  const rows = channels => Array.from({ length: height }, (_, y) => Array.from({ length: width * channels }, (_, i) => value(Math.floor(i / channels), y, i % channels)));
  const decoded = async (colorType, channels, extra = [], depth = 8) => {
    const source = rows(channels * depth / 8);
    return { source, pixels: pixels((await png.decodePng(makePng(width, height, depth, colorType, source, extra, { filters, bpp: channels * depth / 8 }))).raster) };
  };
  const at = (x, y) => y * width + x;

  const gray = await decoded(0, 1, [chunk('tRNS', [0, value(3, 2, 0)])]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const g = gray.source[y][x];
    assert.deepEqual(gray.pixels[at(x, y)], [g, g, g, g === value(3, 2, 0) ? 0 : 255], `gray ${x},${y}`);
  }
  const grayAlpha = await decoded(4, 2);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const [g, a] = grayAlpha.source[y].slice(2 * x, 2 * x + 2);
    assert.deepEqual(grayAlpha.pixels[at(x, y)], [g, g, g, a], `gray+alpha ${x},${y}`);
  }
  const rgb = await decoded(2, 3);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) assert.deepEqual(rgb.pixels[at(x, y)], [...rgb.source[y].slice(3 * x, 3 * x + 3), 255], `RGB ${x},${y}`);
  const wide = await decoded(2, 3, [], 16);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const s = wide.source[y].slice(6 * x, 6 * x + 6);
    assert.deepEqual(wide.pixels[at(x, y)], [0, 2, 4].map(i => Math.round(((s[i] << 8) | s[i + 1]) / 257)).concat(255), `16-bit ${x},${y}`);
  }

  // Every index below 256 is in this palette.
  const palette = chunk('PLTE', Array.from({ length: 768 }, (_, i) => (i * 11) & 255)), trns = chunk('tRNS', [9, 8, 7]);
  const indexed = await decoded(3, 1, [palette, trns]);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
    const e = indexed.source[y][x];
    assert.deepEqual(indexed.pixels[at(x, y)], [e * 3, e * 3 + 1, e * 3 + 2].map(i => (i * 11) & 255).concat(e < 3 ? [9, 8, 7][e] : 255), `palette ${x},${y}`);
  }
  await assert.rejects(png.decodePng(makePng(2, 1, 8, 3, [[0, 2]], [chunk('PLTE', [1, 2, 3, 4, 5, 6])])), /palette lacks/);
});

test('an opaque raster round-trips exactly, its rows each taking the filter that fits them', async () => {
  const width = 41, height = 23, data = new Uint8ClampedArray(width * height * 4);
  let seed = 3;
  for (let i = 0; i < data.length; i++) data[i] = i % 4 === 3 ? 255 : ((seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff) >> 16) & 255;
  const get = (x, y, c) => data[(y * width + x) * 4 + c];
  // Rows each filter predicts exactly from the noise around them: a ramp
  // (Sub), a copy (Up), the mean of left and up (Average), and Paeth's pick.
  const predict = [(x, y, c) => get(x - 1, y, c) + 3, (x, y, c) => get(x, y - 1, c),
    (x, y, c) => (get(x - 1, y, c) + get(x, y - 1, c)) >> 1,
    (x, y, c) => { const a = get(x - 1, y, c), b = get(x, y - 1, c), d = get(x - 1, y - 1, c), p = a + b - d; return Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - d) ? a : Math.abs(p - b) <= Math.abs(p - d) ? b : d; }];
  predict.forEach((f, k) => {
    for (let x = 1; x < width; x++) for (let c = 0; c < 3; c++) data[((4 + 4 * k) * width + x) * 4 + c] = f(x, 4 + 4 * k, c) & 255;
  });
  const bytes = await encode({ width, height, data });
  const list = chunks(bytes);
  assert.equal(list[0].data[9], 2, 'color type RGB');
  const raw = inflateSync(list[1].data), filters = new Set();
  for (let y = 0; y < height; y++) filters.add(raw[y * (width * 3 + 1)]);
  for (const f of [1, 2, 3, 4]) assert.ok(filters.has(f), `filter ${f} wins a row: ${[...filters]}`);
  assert.deepEqual(Array.from((await png.decodePng(bytes)).raster.data), Array.from(data));
});

/** A source the browser's decoder read: `raster` and the color `jpeg.jpegColor` finds in `bytes`, if any. */
const fromCanvas = (bytes, raster = { width: 1, height: 1, data: new Uint8ClampedArray([9, 8, 7, 255]) }) =>
  ({ raster, ...bytes ? jpeg.jpegColor(bytes) : { space: 'srgb', keep: [], notes: [] } });
/** The profile an `iCCP` chunk carries, inflated. */
const iccpProfile = raw => { const data = chunks(Buffer.concat([SIGNATURE, raw]))[0].data; return inflateSync(data.subarray(data.indexOf(0) + 2)); };
const mismatch = (from, to, droppedOther, lostAlpha) => ({ kind: 'formatMismatch', from, to, droppedOther, lostAlpha });

test('a mislabeled image saves as its name\'s type, its RGB profile carried across', async () => {
  const profile = icc({ desc: 'Display P3' });
  // PNG data named .jpg: its profile as JPEG segments, its other chunks dropped.
  const pngData = makePng(2, 1, 8, 6, [[1, 2, 3, 255, 4, 5, 6, 128]], [iccp(profile), chunk('pHYs', [0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1])]);
  const asJpeg = await asSaved(await png.decodePng(pngData), 'image/png', 'image/jpeg');
  assert.equal(asJpeg.space, 'display-p3');
  assert.deepEqual(asJpeg.keep.map(k => [k[0], k[1]]), [[0xff, 0xe2]]);
  assert.deepEqual(Buffer.from(jpeg.iccProfile(asJpeg.keep)), profile);
  assert.deepEqual(asJpeg.notes, [mismatch('image/png', 'image/jpeg', true, true)]);

  // JPEG data named .png: its profile as an iCCP chunk.
  const jpegData = splice(JPEG, [iccSegment(1, 1, profile)]);
  const asPng = await asSaved(fromCanvas(jpegData), 'image/jpeg', 'image/png');
  assert.equal(asPng.space, 'display-p3');
  assert.deepEqual(asPng.keep.map(k => Buffer.from(k).toString('latin1', 4, 8)), ['iCCP']);
  assert.deepEqual(iccpProfile(asPng.keep[0]), profile);
  assert.deepEqual(asPng.notes, [mismatch('image/jpeg', 'image/png', false, false)]);
  const saved = await png.decodePng(await encode(fromCanvas().raster, asPng.keep));
  assert.equal(saved.space, 'display-p3', 'the saved PNG carries the profile');

  // The browser's decoder's other formats save as the name says too.
  assert.deepEqual((await asSaved(fromCanvas(), 'image/gif', 'image/jpeg')).notes, [mismatch('image/gif', 'image/jpeg', false, false)]);

  // Correctly named, the source's metadata stays verbatim and nothing is noted.
  const same = await asSaved(fromCanvas(jpegData), 'image/jpeg', 'image/jpeg');
  assert.deepEqual(same.keep, jpeg.iccSegments(jpegData));
  assert.deepEqual(same.notes, []);
});

test('a mislabeled PNG shows as sRGB when its Display P3 does not survive the untagged save', async () => {
  const p3 = await png.decodePng(makePng(1, 1, 8, 2, [[1, 2, 3]], [chunk('cICP', [12, 13, 0, 1])]));
  assert.equal(p3.space, 'display-p3');
  const asJpeg = await asSaved(p3, 'image/png', 'image/jpeg');
  assert.deepEqual([asJpeg.space, asJpeg.keep], ['srgb', []]);
  assert.deepEqual(asJpeg.notes, [mismatch('image/png', 'image/jpeg', true, false)]);

  // A profile past the 255 segments a JPEG numbers is not carried either.
  const huge = Buffer.concat([icc({ desc: 'Display P3' }), Buffer.alloc(255 * 0xffff)]);
  const tooBig = await asSaved({ ...fromCanvas(), space: 'display-p3', keep: [], profile: huge }, 'image/png', 'image/jpeg');
  assert.equal(tooBig.space, 'srgb');
  assert.equal(tooBig.keep.length + (tooBig.profile ? 1 : 0), 0, 'nothing carried');
});

test('save notes read as one line', () => {
  assert.equal(describe([]), '');
  assert.equal(describe([{ kind: 'depth16' }, { kind: 'profileDropped', space: 'GRAY' }, mismatch('image/png', 'image/jpeg', true, true)]),
    'This 16-bit PNG saves at 8 bits per channel. The save drops this image\'s grayscale color profile, which does not describe RGB pixels. '
    + 'This file holds PNG data; it saves as JPEG, as its name says, without its other metadata, losing its transparency.');
  assert.equal(describe([{ kind: 'profileDropped', space: '' }, mismatch(undefined, 'image/png', false, false)]),
    'The save drops this image\'s unreadable color profile. This file holds non-PNG data; it saves as PNG, as its name says.');
});

test('a JPEG\'s ICC profile is kept only when it describes RGB', () => {
  const cmyk = jpeg.jpegColor(splice(JPEG, [iccSegment(1, 1, icc({ desc: 'U.S. Web Coated (SWOP) v2', space: 'CMYK' }))]));
  assert.deepEqual(cmyk.keep, [], 'a re-encode is YCbCr, which a CMYK profile does not describe');
  assert.equal(cmyk.space, 'srgb');
  assert.deepEqual(cmyk.notes, [{ kind: 'profileDropped', space: 'CMYK' }]);
  const gray = jpeg.jpegColor(splice(JPEG, [iccSegment(1, 1, icc({ desc: 'Gray Gamma 2.2', space: 'GRAY' }))]));
  assert.deepEqual(gray.keep, []);
  assert.deepEqual(gray.notes, [{ kind: 'profileDropped', space: 'GRAY' }]);
  const rgb = jpeg.jpegColor(splice(JPEG, [iccSegment(1, 1, icc({ desc: 'Display P3' }))]));
  assert.deepEqual([rgb.keep.length, rgb.space, rgb.notes], [1, 'display-p3', []]);
});

test('a PNG\'s iCCP is kept only when it describes RGB, as every save is', async () => {
  const gray = icc({ desc: 'Gray Gamma 2.2', space: 'GRAY' }), srgb = chunk('sRGB', [0]), gama = chunk('gAMA', [0, 0, 0xb1, 0x8f]);
  const decoded = await png.decodePng(makePng(2, 1, 8, 0, [[0, 200]], [gama, iccp(gray), srgb]));
  assert.deepEqual(decoded.keep.map(k => Buffer.from(k).toString('latin1', 4, 8)), ['gAMA', 'sRGB']);
  assert.equal(decoded.profile, undefined);
  assert.deepEqual(decoded.notes, [{ kind: 'profileDropped', space: 'GRAY' }]);
  const saved = chunks(await encode(decoded.raster, decoded.keep));
  assert.deepEqual(saved.map(c => c.type), ['IHDR', 'gAMA', 'sRGB', 'IDAT', 'IEND']);
});

/** An `eXIf` chunk holding orientation `o`, big- or little-endian. */
const exif = (o, little = false) => chunk('eXIf', tiff({ orientation: o, little }));

test('a PNG\'s eXIf orientation turns its pixels upright, and a save writes them so without it', async () => {
  // Gray 3×2, rows [10 20 30] / [40 50 60].
  const shown = async extra => {
    const { raster: r } = await png.decodePng(makePng(3, 2, 8, 0, [[10, 20, 30], [40, 50, 60]], extra));
    return { size: [r.width, r.height], rows: Array.from({ length: r.height }, (_, y) => Array.from({ length: r.width }, (_, x) => r.data[(y * r.width + x) * 4])), r };
  };
  assert.deepEqual((await shown([exif(3)])).rows, [[60, 50, 40], [30, 20, 10]]);
  const six = await shown([exif(6)]);
  assert.deepEqual([six.size, six.rows], [[2, 3], [[40, 10], [50, 20], [60, 30]]], 'a quarter turn clockwise');
  const eight = await shown([exif(8, true)]);
  assert.deepEqual([eight.size, eight.rows], [[2, 3], [[30, 60], [20, 50], [10, 40]]], 'a quarter turn counterclockwise, little-endian');

  const saved = await encode(six.r, (await png.decodePng(makePng(3, 2, 8, 0, [[10, 20, 30], [40, 50, 60]], [exif(6)]))).keep);
  assert.ok(!chunks(saved).some(c => c.type === 'eXIf'), 'the save drops eXIf');
  assert.deepEqual(Array.from((await png.decodePng(saved)).raster.data), Array.from(six.r.data), 'and holds the upright pixels');
});

test('only a full-range SDR cICP shows as its space; an HDR or narrow-range PNG is view-only', async () => {
  assert.equal(cicpSpace(new Uint8Array([12, 13, 0, 1])), 'display-p3');
  assert.equal(cicpSpace(new Uint8Array([12, 1, 0, 1])), 'display-p3');
  assert.equal(cicpSpace(new Uint8Array([12, 16, 0, 1])), 'srgb', 'PQ is not SDR');
  assert.equal(cicpSpace(new Uint8Array([12, 13, 0, 0])), 'srgb', 'narrow range');
  assert.equal(cicpSpace(new Uint8Array([12, 8, 0, 1])), 'srgb', 'linear: no canvas space');

  const header = cicp => makePng(4, 4, 16, 2, [], [chunk('cICP', cicp)]);
  assert.match(imageEditability(100, header([9, 16, 0, 1])).viewOnly, /HDR/, 'PQ');
  assert.match(imageEditability(100, header([9, 18, 0, 1])).viewOnly, /HDR/, 'HLG');
  assert.match(imageEditability(100, header([12, 13, 0, 0])).viewOnly, /narrow-range/);
  assert.deepEqual(imageEditability(100, header([12, 13, 0, 1])), { ok: true });
  assert.deepEqual(imageEditability(100, header([1, 8, 0, 1])), { ok: true }, 'another SDR transfer shows approximately');
  assert.match((await decodeImage(new Blob([header([9, 16, 0, 1])]))).viewOnly, /HDR/, 'the page checks again');
});

test('the PNG worker decodes and encodes, handing its buffers back', async () => {
  const sent = [];
  globalThis.self = {};
  globalThis.postMessage = (message, options) => sent.push({ message, transfer: options?.transfer });
  await load('../viewer/image/png-worker.ts');
  const source = makePng(2, 1, 8, 6, [[1, 2, 3, 4, 5, 6, 7, 8]], [iccp(icc({ desc: 'Display P3' }))]);
  await self.onmessage({ data: { decode: source } });
  const { result } = sent[0].message;
  assert.deepEqual(Array.from(result.raster.data), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(result.space, 'display-p3');
  assert.ok(sent[0].transfer.includes(result.raster.data.buffer), 'the raster is transferred');

  await self.onmessage({ data: { encode: { raster: result.raster, keep: result.keep } } });
  assert.equal((await png.decodePng(new Uint8Array(Buffer.concat(sent[1].message.result)))).space, 'display-p3');

  await self.onmessage({ data: { decode: new Uint8Array(8) } });
  assert.match(sent[2].message.error, /Not a PNG/);
});

test('a save writes the type its name gives, whatever its bytes hold', () => {
  assert.equal(saveType('image/png', 'image/jpeg'), 'image/png');
  assert.equal(saveType('image/jpeg', 'image/png'), 'image/jpeg');
  assert.equal(saveType('image/jpeg', 'image/gif'), 'image/jpeg');
  assert.equal(saveType('', 'image/jpeg'), 'image/jpeg');
  assert.equal(saveType('', 'image/gif'), 'image/png');
});

test('a JPEG save records the resolution in its JFIF header, written when the encoder wrote none', () => {
  // The encoder's JFIF header records only an aspect (units 0).
  assert.equal(imageResolution(JPEG).dpi, null);
  const app0 = markers(JPEG).list[0].bytes;
  const patched = splice(JPEG, [], 144), header = markers(patched).list[0].bytes;
  assert.deepEqual(Array.from(header.subarray(11, 16)), [1, 0, 144, 0, 144], 'units 1, the inch, then the density across and down');
  assert.deepEqual(Buffer.from(patched).fill(0, 13, 18), Buffer.from(JPEG).fill(0, 13, 18), 'nothing else changes');
  assert.equal(app0[11], 0, 'the encoder\'s bytes are untouched');
  assert.equal(imageResolution(patched).dpi, 144);
  assert.equal(imageResolution(splice(JPEG, [], 143.99)).dpi, 144, 'a resolution from pixels per metre rounds');

  // With no APP0, or another first, a JFIF header goes right after SOI.
  const bare = new Uint8Array(Buffer.concat([JPEG.subarray(0, 2), JPEG.subarray(2 + app0.length)]));
  const written = splice(bare, [iccSegment(1, 1, icc({ desc: 'Display P3' }))], 216);
  assert.deepEqual(markers(written).list.map(s => s.marker).slice(0, 3), [0xe0, 0xe2, markers(bare).list[0].marker]);
  assert.equal(imageResolution(written).dpi, 216);
  const jfxx = Buffer.from([0xff, 0xe0, 0, 8, ...Buffer.from('JFXX\0', 'latin1'), 0x10]);
  const ahead = splice(new Uint8Array(Buffer.concat([JPEG.subarray(0, 2), jfxx, bare.subarray(2)])), [], 144);
  assert.deepEqual(markers(ahead).list.slice(0, 2).map(s => Buffer.from(s.bytes).toString('latin1', 4, 8)), ['JFIF', 'JFXX']);
  assert.equal(imageResolution(ahead).dpi, 144);
});

/** The page's codecs in this thread: the PNG worker runs here, and a canvas
 * encodes every JPEG as `JPEG` (whose JFIF header records no resolution) and
 * decodes any image as one gray pixel. */
function fakeBrowser() {
  globalThis.Worker = class {
    postMessage(job) {
      const run = 'decode' in job ? png.decodePng(job.decode) : png.encodePng(job.encode.raster, job.encode.keep);
      run.then(result => this.onmessage({ data: { result } }), error => this.onmessage({ data: { error: error.message } }));
    }
    terminate() {}
  };
  globalThis.ImageData = class { constructor(data, width, height) { Object.assign(this, { data, width, height }); } };
  globalThis.createImageBitmap = async () => ({ width: 1, height: 1, close() {} });
  globalThis.document = { createElement: () => ({
    getContext: () => ({ drawImage() {}, putImageData() {}, getImageData: () => ({ data: new Uint8ClampedArray([128, 128, 128, 255]) }) }),
    toBlob: done => done(new Blob([JPEG], { type: 'image/jpeg' })),
  }) };
}

test('a save writes the resolution its source records, in either format', async () => {
  fakeBrowser();
  /** `bytes` opened as `type` and saved, unedited. */
  const resave = async (bytes, type) => {
    const { edit } = await decodeImage(new Blob([bytes]), type);
    return { edit, saved: new Uint8Array(await (await encodeImage(edit.raster, edit)).arrayBuffer()) };
  };
  const dpi = bytes => Math.round(imageResolution(bytes).dpi);
  const phys = chunk('pHYs', [0, 0, 0x16, 0x25, 0, 0, 0x16, 0x25, 1]);

  // A PNG whose resolution is only in its eXIf, which the save drops, gains a pHYs.
  const exifOnly = await resave(makePng(1, 1, 8, 2, [[1, 2, 3]], [chunk('eXIf', tiff({ xres: [144, 1] }))]), 'image/png');
  assert.equal(exifOnly.edit.dpi, 144);
  assert.deepEqual(chunks(exifOnly.saved).filter(c => c.type === 'pHYs').map(c => c.raw), [phys], '5669 pixels per metre');
  // One that has a pHYs keeps it verbatim, and only it.
  const withPhys = await resave(makePng(1, 1, 8, 2, [[1, 2, 3]], [phys, chunk('eXIf', tiff({ xres: [72, 1] }))]), 'image/png');
  assert.deepEqual(chunks(withPhys.saved).filter(c => c.type === 'pHYs').map(c => c.raw), [phys]);

  // An aspect-only pHYs (unit 0) records no resolution: the eXIf's replaces it, keeping its aspect.
  const aspectOnly = () => makePng(1, 1, 8, 2, [[1, 2, 3]], [chunk('pHYs', [0, 0, 0, 1, 0, 0, 0, 2, 0]), chunk('eXIf', tiff({ xres: [144, 1] }))]);
  const upgraded = await resave(aspectOnly(), 'image/png');
  assert.deepEqual(chunks(upgraded.saved).filter(c => c.type === 'pHYs').map(c => Array.from(c.data)), [[0, 0, 0x16, 0x25, 0, 0, 0x2c, 0x4a, 1]], '5669 across, twice that down');

  // A JPEG re-encoded by a canvas, whose own header records none.
  assert.equal(dpi((await resave(splice(JPEG, [], 144), 'image/jpeg')).saved), 144);

  // Across formats, both ways: the pHYs is carried, so not noted as dropped.
  const pngAsJpeg = await resave(makePng(1, 1, 8, 2, [[1, 2, 3]], [phys]), 'image/jpeg');
  assert.equal(dpi(pngAsJpeg.saved), 144);
  assert.equal(pngAsJpeg.edit.note, describe([mismatch('image/png', 'image/jpeg', false, false)]));
  // An aspect-only pHYs is not carried, so is noted as dropped.
  const aspectAsJpeg = await resave(aspectOnly(), 'image/jpeg');
  assert.equal(dpi(aspectAsJpeg.saved), 144);
  assert.equal(aspectAsJpeg.edit.note, describe([mismatch('image/png', 'image/jpeg', true, false)]));
  const jpegAsPng = await resave(splice(JPEG, [], 216), 'image/png');
  assert.equal(jpegAsPng.edit.mime, 'image/png');
  assert.equal(dpi(jpegAsPng.saved), 216);

  // Nothing recorded, nothing written.
  assert.ok(!chunks((await resave(makePng(1, 1, 8, 2, [[1, 2, 3]]), 'image/png')).saved).some(c => c.type === 'pHYs'));
  assert.equal(imageResolution((await resave(JPEG, 'image/jpeg')).saved).dpi, null);
});

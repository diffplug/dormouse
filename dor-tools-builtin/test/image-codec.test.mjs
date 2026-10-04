import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { crc32 as zlibCrc32, deflateSync, inflateSync } from 'node:zlib';
import { build } from 'esbuild';

// viewer/ is bundled for the browser, never compiled to dist, so the test bundles it too.
async function load(path) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const png = await load('../viewer/image/png.ts');
const jpeg = await load('../viewer/image/jpeg.ts');
const { iccSpace } = await load('../viewer/image/icc.ts');
const { over } = await load('../viewer/image/io.ts');

// PNGs built here with Node's zlib and CRC, independently of the codec under test.
const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
function chunk(type, data) {
  const body = Buffer.concat([Buffer.from(type, 'latin1'), Buffer.from(data)]);
  const length = Buffer.alloc(4), crc = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  crc.writeUInt32BE(zlibCrc32(body));
  return Buffer.concat([length, body, crc]);
}
function ihdr(width, height, depth, colorType, interlace = 0) {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(width, 0); b.writeUInt32BE(height, 4);
  b[8] = depth; b[9] = colorType; b[12] = interlace;
  return chunk('IHDR', b);
}
/** A PNG whose scanlines (each without its filter byte) are `rows`, all filter None. */
function makePng(width, height, depth, colorType, rows, extra = []) {
  const raw = Buffer.concat(rows.map(r => Buffer.concat([Buffer.from([0]), Buffer.from(r)])));
  return new Uint8Array(Buffer.concat([SIGNATURE, ihdr(width, height, depth, colorType), ...extra, chunk('IDAT', deflateSync(raw)), chunk('IEND', [])]));
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

/** An ICC profile holding just a description tag (v2 `desc` or v4 `mluc`) or colorants. */
function icc({ desc, mluc, colorants }) {
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
  const bytes = await png.encodePng(raster);

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
  const bytes = await png.encodePng(raster);
  assert.equal(chunks(bytes)[0].data[9], 2, 'color type RGB');
  assert.deepEqual(Array.from((await png.decodePng(bytes)).raster.data), Array.from(raster.data));
});

test('the decoder checks CRCs', async () => {
  const bytes = await png.encodePng({ width: 1, height: 1, data: new Uint8ClampedArray([1, 2, 3, 4]) });
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
  assert.match(sixteen.note, /16-bit/);
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
  const saved = chunks(await png.encodePng(decoded.raster, decoded.keep));
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
  assert.equal(iccSpace(icc({ desc: 'Adobe RGB (1998)', colorants: [0.6097, 0.3111, 0.0195, 0.2053, 0.6257, 0.0609, 0.1492, 0.0632, 0.7446] })), null);
  const space = async extra => (await png.decodePng(makePng(1, 1, 8, 0, [[0]], extra))).space;
  assert.equal(await space([iccp(icc({ desc: 'sRGB' })), chunk('cICP', [12, 13, 0, 1])]), 'display-p3', 'cICP wins');
  assert.equal(await space([iccp(icc({ desc: 'Display P3' }))]), 'display-p3');
  assert.equal(await space([chunk('sRGB', [0])]), 'srgb');
});

test('compositing a layer leaves the pixels it does not cover exact', () => {
  const r = { width: 3, height: 1, data: new Uint8ClampedArray([10, 20, 30, 0, 200, 100, 50, 128, 1, 2, 3, 0]) };
  const out = over(r, new Uint8ClampedArray([0, 0, 0, 0, 255, 0, 0, 255, 0, 0, 255, 102]));
  assert.deepEqual(pixels(out), [[10, 20, 30, 0], [255, 0, 0, 255], [0, 0, 255, 102]]);
  assert.deepEqual(Array.from(r.data.subarray(4, 8)), [200, 100, 50, 128], 'the source is untouched');
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
  const source = jpeg.spliceIcc(JPEG, [iccSegment(2, 2, profile.subarray(100)), iccSegment(1, 2, profile.subarray(0, 100))]);
  const keep = jpeg.iccSegments(source);
  assert.equal(keep.length, 2);
  assert.deepEqual(Buffer.from(jpeg.iccProfile(keep)), profile, 'rejoined by sequence number');
  assert.equal(iccSpace(jpeg.iccProfile(keep)), 'display-p3');

  // An encoder's own (sRGB) profile gives way to the source's.
  const encoded = jpeg.spliceIcc(JPEG, [iccSegment(1, 1, icc({ desc: 'sRGB' }))]);
  const saved = jpeg.spliceIcc(encoded, keep);
  const { list, scan } = markers(saved), original = markers(JPEG);
  assert.deepEqual(list.map(s => s.marker), [0xe0, 0xe2, 0xe2, ...original.list.slice(1).map(s => s.marker)]);
  assert.deepEqual(list.slice(1, 3).map(s => Array.from(s.bytes)), keep.map(s => Array.from(s)));
  assert.deepEqual(Buffer.from(saved.subarray(scan)), Buffer.from(JPEG.subarray(original.scan)), 'the scan and EOI are untouched');
  assert.deepEqual(jpeg.spliceIcc(saved, []), JPEG, 'splicing nothing strips the profile');
});

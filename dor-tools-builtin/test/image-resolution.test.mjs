import assert from 'node:assert/strict';
import { test } from 'node:test';
import { exifFields, pngChunks } from '../dist/image-editability.js';
import { defaultDisplayWidth, displayScale, imageResolution } from '../dist/image-resolution.js';
import { chunk, tiff } from './bundle.mjs';

const u16 = n => [n >> 8, n & 0xff];
const u32 = n => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
const text = s => [...s].map(c => c.charCodeAt(0));

/** A PNG head: IHDR, then `pHYs` as [pixels per unit, unit] and `eXIf` when given, then IDAT. */
function png({ width = 2880, height = 1800, phys, exif } = {}) {
  return Uint8Array.from([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ...chunk('IHDR', [...u32(width), ...u32(height), 8, 6, 0, 0, 0]),
    ...exif ? chunk('eXIf', exif) : [],
    ...phys ? chunk('pHYs', [...u32(phys[0]), ...u32(phys[0]), phys[1]]) : [],
    ...chunk('IDAT', [0]),
  ]);
}

/** A JPEG head: SOI, a JFIF APP0 as [units, density] (cut to its first `jfifLength` bytes) and an EXIF APP1 when given, SOF0, then SOS. */
function jpeg({ width = 1200, height = 800, jfif, jfifLength = 14, jfifTag = 'JFIF\0', exif } = {}) {
  const segment = (marker, data) => [0xff, marker, ...u16(data.length + 2), ...data];
  return Uint8Array.from([
    0xff, 0xd8,
    ...jfif ? segment(0xe0, [...text(jfifTag), 1, 1, jfif[0], ...u16(jfif[1]), ...u16(jfif[1]), 0, 0].slice(0, jfifLength)) : [],
    ...exif ? segment(0xe1, [...text('Exif\0\0'), ...exif]) : [],
    ...segment(0xc0, [8, ...u16(height), ...u16(width), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]),
    0xff, 0xda,
  ]);
}

test('a scale is macOS\'s 2× or 3× of 72 dpi, else a whole multiple of 96 dpi from 2×, within 1 dpi', () => {
  for (const [dpi, scale] of [[null, 1], [0, 1], [1, 1], [72, 1], [96, 1], [143.99, 2], [144, 2], [145, 2], [216, 3], [192, 2], [288, 3], [384, 4], [576, 6], [432, 1], [150, 1], [300, 1], [146, 1], [190, 1]]) {
    assert.equal(displayScale(dpi), scale, `${dpi} dpi`);
  }
});

test('a PNG records its resolution in pHYs per metre, else its eXIf', () => {
  // A Retina screenshot: 5669 pixels per metre, 144 dpi.
  assert.equal(Math.round(imageResolution(png({ phys: [5669, 1] })).dpi), 144);
  assert.equal(defaultDisplayWidth(png({ phys: [5669, 1] })), 1440);
  assert.equal(defaultDisplayWidth(png({ phys: [8504, 1] })), 960);
  assert.equal(defaultDisplayWidth(png({ phys: [7559, 1] })), 1440, '192 dpi, Windows at 200%');
  // Unit 0 records only an aspect ratio.
  assert.equal(imageResolution(png({ phys: [5669, 0] })).dpi, null);
  assert.equal(defaultDisplayWidth(png({ phys: [5669, 0] })), null);
  assert.equal(defaultDisplayWidth(png({ phys: [2835, 1] })), null, '72 dpi');
  assert.equal(defaultDisplayWidth(png({ phys: [3780, 1] })), null, '96 dpi');
  assert.equal(defaultDisplayWidth(png()), null);
  assert.equal(defaultDisplayWidth(png({ exif: tiff({ xres: [144, 1], unit: 2 }) })), 1440);
  assert.equal(defaultDisplayWidth(png({ phys: [2835, 1], exif: tiff({ xres: [144, 1] }) })), null, 'pHYs before eXIf');
  // A head that ends inside a chunk stops there.
  assert.equal(imageResolution(png({ phys: [5669, 1] }).subarray(0, 50)).dpi, null);
});

test('a JPEG records its resolution in JFIF dots per inch or centimetre, else its EXIF', () => {
  assert.equal(imageResolution(jpeg({ jfif: [1, 144] })).dpi, 144);
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 144] })), 600);
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 216] })), 400);
  // 57 dots per centimetre is 144.78 dpi.
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [2, 57] })), 600);
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [0, 144] })), null, 'aspect only');
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 144], jfifTag: 'JFXX\0' })), null, 'not JFIF');
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 72] })), null);
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 300] })), null);
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [0, 1], exif: tiff({ xres: [288, 2], unit: 2 }) })), 600);
  assert.equal(defaultDisplayWidth(jpeg({ exif: tiff({ xres: [5669, 100], unit: 3 }) })), 600, '56.69 dots per centimetre');
  assert.equal(defaultDisplayWidth(jpeg({ exif: tiff({ xres: [144, 1] }) })), 600, 'the inch by default');
  assert.equal(defaultDisplayWidth(jpeg({ exif: tiff({ xres: [144, 1], unit: 1 }) })), null, 'no absolute unit');
  assert.equal(defaultDisplayWidth(jpeg({ exif: tiff({ xres: [72, 1] }) })), null);
  // A JFIF header cut after its units reads nothing past its segment (here, SOF0's marker).
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 144], jfifLength: 8 })), null);
});

test('a quarter-turned image shows as wide as its frame is tall', () => {
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 144], exif: tiff({ orientation: 6 }) })), 400);
  assert.equal(defaultDisplayWidth(png({ phys: [5669, 1], exif: tiff({ orientation: 8 }) })), 900);
  assert.equal(defaultDisplayWidth(jpeg({ jfif: [1, 144], exif: tiff({ orientation: 3 }) })), 600);
});

test('EXIF fields read from either byte order and stop at the end of the block', () => {
  const big = Uint8Array.from(tiff({ orientation: 6, xres: [300, 1], unit: 2 }));
  assert.deepEqual(exifFields(big), { orientation: 6, dpi: 300 });
  assert.deepEqual(exifFields(Uint8Array.from(tiff({ orientation: 5, xres: [144, 1], unit: 2, little: true }))), { orientation: 5, dpi: 144 }, 'little-endian');
  assert.deepEqual(exifFields(big.subarray(0, 20)), { orientation: 1, dpi: null });
  // Every entry, but not the resolution they point at.
  assert.deepEqual(exifFields(big.subarray(0, big.length - 8)), { orientation: 6, dpi: null });
  assert.equal(exifFields(Uint8Array.from(tiff({ xres: [144, 0] }))).dpi, null);
  assert.equal(exifFields(Uint8Array.from(tiff({ orientation: 9 }))).orientation, 1);
  assert.equal(exifFields(Uint8Array.from(tiff({ orientation: 6, orientationType: 4 }))).orientation, 1, 'not a SHORT');
  assert.equal(imageResolution(Uint8Array.from([1, 2, 3])), null);
  // Too short, an IFD past the end, and no byte order.
  assert.deepEqual(exifFields(Uint8Array.from([0x4d, 0x4d, 0, 42])), { orientation: 1, dpi: null });
  assert.deepEqual(exifFields(Uint8Array.from([0x4d, 0x4d, 0, 42, 0, 0, 0, 100])), { orientation: 1, dpi: null });
  assert.equal(exifFields(Uint8Array.from([0, 0, ...big.subarray(2)])).orientation, 1);
});

test('a PNG\'s metadata chunks are those before its image data, or before its head ends', () => {
  const head = png({ phys: [5669, 1], exif: tiff({ orientation: 6 }) });
  assert.deepEqual(pngChunks(head).map(c => c.type), ['IHDR', 'eXIf', 'pHYs']);
  const [, exif, phys] = pngChunks(head);
  assert.deepEqual([exif.end, phys.start, phys.end - phys.start], [phys.start, exif.end, 21], 'each whole, with its CRC');
  assert.deepEqual(pngChunks(head.subarray(0, phys.end - 1)).map(c => c.type), ['IHDR', 'eXIf'], 'a chunk cut short is not listed');
  assert.deepEqual(pngChunks(head.subarray(0, 8)), []);
  assert.deepEqual(pngChunks(Uint8Array.from([1, 2, 3])), []);
});

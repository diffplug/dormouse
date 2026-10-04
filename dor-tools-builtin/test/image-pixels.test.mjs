import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

// viewer/ is bundled for the browser, never compiled to dist, so the test bundles it too.
async function load(path) {
  const bundle = await build({
    entryPoints: [fileURLToPath(new URL(path, import.meta.url))],
    bundle: true, format: 'esm', platform: 'neutral', write: false, logLevel: 'silent',
  });
  return import(`data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`);
}
const px = await load('../viewer/image/pixels.ts');
const { History, Pieces } = await load('../viewer/image/history.ts');

const WHITE = [255, 255, 255, 255], BLACK = [0, 0, 0, 255], RED = [255, 0, 0, 255], BLUE = [0, 0, 255, 255];

function raster(width, height, color = WHITE) {
  const r = px.createRaster(width, height);
  px.fillRect(r, { x: 0, y: 0, width, height }, color);
  return r;
}
const at = (r, x, y) => px.pixel(r, x, y);
/** Every pixel's color, packed into strings for whole-raster comparisons. */
const colors = r => Array.from({ length: r.width * r.height }, (_, i) => r.data.slice(i * 4, i * 4 + 4).join(','));
/** The bucket: fills the flood region, returning its bounds. */
function floodFill(r, x, y, color, tolerance) {
  const region = px.floodRegion(r, x, y, color, tolerance);
  if (region) px.fillSelection(r, region.rect, region.mask, color);
  return region?.rect ?? null;
}

test('pixel and toHex read the eyedropper color', () => {
  const r = raster(2, 2);
  px.fillRect(r, { x: 1, y: 1, width: 1, height: 1 }, [18, 52, 86, 128]);
  assert.deepEqual(at(r, 1.7, 1.2), [18, 52, 86, 128]);
  assert.equal(at(r, 2, 0), null);
  assert.equal(px.toHex(at(r, 1, 1)), '#12345680');
  assert.equal(px.toHex(WHITE), '#ffffff');
});

test('flood fill takes exactly the seed color at tolerance 0, and near colors within tolerance', () => {
  const r = raster(5, 1);
  px.fillRect(r, { x: 2, y: 0, width: 1, height: 1 }, [250, 255, 255, 255]);
  assert.deepEqual(floodFill(r, 0, 0, RED, 0), { x: 0, y: 0, width: 2, height: 1 });
  assert.deepEqual(at(r, 2, 0), [250, 255, 255, 255]);
  assert.deepEqual(at(r, 3, 0), WHITE);

  const s = raster(5, 1);
  px.fillRect(s, { x: 2, y: 0, width: 1, height: 1 }, [250, 255, 255, 255]);
  assert.deepEqual(floodFill(s, 0, 0, RED, 5), { x: 0, y: 0, width: 5, height: 1 });
  assert.ok(colors(s).every(c => c === RED.join(',')));
  const t = raster(3, 1);
  px.fillRect(t, { x: 1, y: 0, width: 1, height: 1 }, [249, 255, 255, 255]);
  floodFill(t, 0, 0, RED, 5);
  assert.deepEqual(at(t, 2, 0), WHITE, 'the tolerance is against the seed, not a neighbor');
});

test('flood fill is 4-connected, stays inside walls, and reports the filled bounds', () => {
  // A black ring around a 3×3 interior, in a white 7×7 field.
  const r = raster(7, 7);
  px.fillRect(r, { x: 1, y: 1, width: 5, height: 5 }, BLACK);
  px.fillRect(r, { x: 2, y: 2, width: 3, height: 3 }, WHITE);
  assert.deepEqual(floodFill(r, 3, 3, RED), { x: 2, y: 2, width: 3, height: 3 });
  assert.deepEqual(at(r, 0, 0), WHITE);
  assert.deepEqual(at(r, 1, 1), BLACK);

  // Diagonal neighbours do not connect.
  const d = raster(2, 2);
  px.fillRect(d, { x: 1, y: 0, width: 1, height: 1 }, BLACK);
  px.fillRect(d, { x: 0, y: 1, width: 1, height: 1 }, BLACK);
  assert.deepEqual(floodFill(d, 0, 0, RED), { x: 0, y: 0, width: 1, height: 1 });
  assert.deepEqual(at(d, 1, 1), WHITE);

  // The outside field wraps around the ring to every edge.
  assert.deepEqual(floodFill(r, 0, 0, BLUE), { x: 0, y: 0, width: 7, height: 7 });
  assert.deepEqual(at(r, 6, 6), BLUE);
});

test('flood fill is a no-op off the raster or on a seed already the fill color', () => {
  const r = raster(3, 3, RED);
  const before = colors(r);
  assert.equal(floodFill(r, 1, 1, RED, 0), null);
  assert.equal(floodFill(r, -1, 1, BLUE, 0), null);
  assert.equal(floodFill(r, 3, 0, BLUE, 0), null);
  assert.deepEqual(colors(r), before);
});

test('floodRegion finds the region without painting it, so its pixels can be kept first', () => {
  const r = raster(4, 2);
  px.fillRect(r, { x: 2, y: 0, width: 1, height: 2 }, BLACK);
  const before = colors(r);
  const region = px.floodRegion(r, 0, 0, RED);
  assert.deepEqual(region.rect, { x: 0, y: 0, width: 2, height: 2 });
  assert.deepEqual(Array.from(region.mask), [1, 1, 0, 0, 1, 1, 0, 0]);
  assert.deepEqual(colors(r), before);
});

test('flood fill covers a 4000×4000 maze-like image without overflowing the stack', () => {
  const size = 4000, r = raster(size, size);
  // Vertical walls with alternating gaps make one long serpentine region.
  for (let x = 1; x < size; x += 2) px.fillRect(r, { x, y: (x >> 1) % 2 ? 0 : 1, width: 1, height: size - 1 }, BLACK);
  const bounds = floodFill(r, 0, 0, RED);
  assert.deepEqual(bounds, { x: 0, y: 0, width: size, height: size });
  assert.deepEqual(at(r, size - 2, size - 1), RED);
  assert.deepEqual(at(r, size - 1, size - 1), RED, 'the last wall\'s gap');
  assert.deepEqual(at(r, 1, 2), BLACK);
});

test('drawLine writes only full target-color pixels and connects endpoints diagonally', () => {
  for (const [size, shape] of [[1, 'square'], [3, 'square'], [4, 'round'], [5, 'round']]) {
    const r = px.createRaster(20, 20);
    px.drawLine(r, 2.6, 3.2, 15, 11, px.stamp(size, shape), RED);
    for (const c of colors(r)) assert.ok(c === '0,0,0,0' || c === RED.join(','), `${size} ${shape}: ${c}`);
    assert.deepEqual(at(r, 2, 3), RED);
    assert.deepEqual(at(r, 15, 11), RED);
  }

  // A one-pixel diagonal is exactly the diagonal: each step moves on both axes.
  const d = px.createRaster(6, 6);
  px.drawLine(d, 0, 0, 5, 5, px.stamp(1, 'square'), RED);
  const painted = colors(d).flatMap((c, i) => c === '0,0,0,0' ? [] : [[i % 6, Math.floor(i / 6)]]);
  assert.deepEqual(painted, [[0, 0], [1, 1], [2, 2], [3, 3], [4, 4], [5, 5]]);

  // A shallow line has one pixel per column with no gaps.
  const s = px.createRaster(10, 4);
  px.drawLine(s, 9, 3, 0, 0, px.stamp(1, 'square'), RED);
  for (let x = 0; x < 10; x++) assert.equal([0, 1, 2, 3].filter(y => at(s, x, y)[3]).length, 1, `column ${x}`);
});

test('drawLine stamps square and round brushes and clips at the edges', () => {
  const square = px.createRaster(5, 5), round = px.createRaster(5, 5);
  px.drawLine(square, 2, 2, 2, 2, px.stamp(3, 'square'), RED);
  px.drawLine(round, 2, 2, 2, 2, px.stamp(3, 'round'), RED);
  assert.equal(colors(square).filter(c => c !== '0,0,0,0').length, 9);
  assert.equal(colors(round).filter(c => c !== '0,0,0,0').length, 5);
  assert.equal(at(round, 1, 1)[3], 0);

  const edge = px.createRaster(3, 3);
  px.drawLine(edge, -5, 1, 10, 1, px.stamp(1, 'square'), RED);
  assert.deepEqual([0, 1, 2].map(x => at(edge, x, 1)), [RED, RED, RED]);
});

test('drawLine returns the rectangle it painted, clipped, and null when it painted nothing', () => {
  for (const [size, shape] of [[1, 'square'], [4, 'square'], [5, 'round']]) {
    const r = px.createRaster(20, 20);
    const painted = px.drawLine(r, 3, 15, 12.5, 6, px.stamp(size, shape), RED);
    const xs = [], ys = [];
    colors(r).forEach((c, i) => { if (c !== '0,0,0,0') { xs.push(i % 20); ys.push(Math.floor(i / 20)); } });
    const x = Math.min(...xs), y = Math.min(...ys);
    assert.deepEqual(painted, { x, y, width: Math.max(...xs) - x + 1, height: Math.max(...ys) - y + 1 }, `${size} ${shape}`);
  }
  assert.deepEqual(px.drawLine(px.createRaster(4, 4), -3, 1, 1, 1, px.stamp(3, 'square'), RED), { x: 0, y: 0, width: 3, height: 3 });
  assert.equal(px.drawLine(px.createRaster(4, 4), -9, -9, -5, -5, px.stamp(3, 'square'), RED), null);
});

test('polygonMask selects the pixels whose centers fall inside a triangle', () => {
  const mask = px.polygonMask(6, 4, [{ x: 0, y: 0 }, { x: 6, y: 0 }, { x: 0, y: 6 }]);
  const rows = [0, 1, 2, 3].map(y => Array.from(mask.subarray(y * 6, y * 6 + 6)).join(''));
  assert.deepEqual(rows, ['111110', '111100', '111000', '110000']);
  assert.deepEqual(px.maskBounds(mask, 6, 4), { x: 0, y: 0, width: 5, height: 4 });
  assert.equal(px.polygonMask(4, 4, [{ x: 0, y: 0 }, { x: 4, y: 4 }]).some(Boolean), false);
});

test('erasing a selection fills the hole with the ring\'s dominant color', () => {
  // A blue 2×2 square on white, with one red pixel in the ring around it.
  const r = raster(6, 6);
  px.fillRect(r, { x: 2, y: 2, width: 2, height: 2 }, BLUE);
  px.fillRect(r, { x: 1, y: 1, width: 1, height: 1 }, RED);
  px.fillRect(r, { x: 0, y: 0, width: 1, height: 6 }, BLACK);
  const rect = { x: 2, y: 2, width: 2, height: 2 };
  assert.deepEqual(px.dominantBorderColor(r, rect), WHITE);

  const lifted = px.copyRegion(r, rect);
  px.eraseSelection(r, rect);
  assert.deepEqual(colors(lifted), Array(4).fill(BLUE.join(',')));
  assert.deepEqual([at(r, 2, 2), at(r, 3, 3)], [WHITE, WHITE]);
  assert.deepEqual(at(r, 1, 1), RED);

  // Pasting the lift back elsewhere moves it; a lasso lift is transparent outside its mask.
  px.paste(r, lifted, 4, 4);
  assert.deepEqual(at(r, 5, 5), BLUE);
  const s = raster(4, 4, BLUE);
  px.fillRect(s, { x: 0, y: 0, width: 4, height: 1 }, RED);
  px.fillRect(s, { x: 1, y: 1, width: 1, height: 1 }, BLACK);
  const mask = px.polygonMask(4, 4, [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 1, y: 4 }]), bounds = px.maskBounds(mask, 4, 4);
  const tri = px.copyRegion(s, bounds, mask);
  px.eraseSelection(s, bounds, mask);
  assert.deepEqual(at(s, 1, 1), BLUE, 'the ring outside a lasso includes the unselected bounding-box pixels');
  assert.deepEqual(at(tri, 0, 0), BLACK);
  assert.deepEqual([tri.width, tri.height], [2, 2]);
  assert.deepEqual(at(tri, 0, 1), BLUE);
  assert.equal(at(tri, 1, 1)[3], 0);
  assert.deepEqual(at(s, 2, 2), BLUE, 'unmasked pixels stay');
  assert.equal(px.dominantBorderColor(s, { x: 0, y: 0, width: 4, height: 4 }), null);
  const all = raster(2, 2, RED);
  px.eraseSelection(all, { x: 0, y: 0, width: 2, height: 2 });
  assert.ok(colors(all).every(c => c === '0,0,0,0'), 'with no ring, the hole is transparent');
});

test('insertSeam opens a band of replicated edge pixels and removeSeam takes it back', () => {
  const r = px.createRaster(3, 2);
  [[0, 0, RED], [1, 0, BLUE], [2, 0, BLACK], [0, 1, WHITE], [1, 1, BLACK], [2, 1, RED]]
    .forEach(([x, y, c]) => px.fillRect(r, { x, y, width: 1, height: 1 }, c));

  const wide = px.insertSeam(r, 'x', 2, 3);
  assert.deepEqual([wide.width, wide.height], [6, 2]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(x => at(wide, x, 0)), [RED, BLUE, BLUE, BLUE, BLUE, BLACK]);
  assert.deepEqual([0, 1, 2, 3, 4, 5].map(x => at(wide, x, 1)), [WHITE, BLACK, BLACK, BLACK, BLACK, RED]);
  assert.deepEqual(colors(px.removeSeam(wide, 'x', 2, 5)), colors(r));

  const tall = px.insertSeam(r, 'y', 0, 2);
  assert.deepEqual([tall.width, tall.height], [3, 4]);
  assert.deepEqual([0, 1, 2, 3].map(y => at(tall, 1, y)), [BLUE, BLUE, BLUE, BLACK], 'at 0 replicates the first row');
  assert.deepEqual(colors(px.removeSeam(tall, 'y', 2, 0)), colors(r));

  const end = px.insertSeam(r, 'y', 99, 1);
  assert.deepEqual(at(end, 2, 2), RED);
  assert.deepEqual(colors(px.insertSeam(r, 'x', 1, 0)), colors(r));
  assert.equal(px.removeSeam(r, 'x', -4, 99).width, 0);
});

test('crop and paste clip to the raster', () => {
  const r = raster(4, 4);
  px.fillRect(r, { x: -2, y: -2, width: 3, height: 3 }, RED);
  assert.deepEqual(at(r, 0, 0), RED);
  assert.deepEqual(at(r, 1, 1), WHITE);

  const piece = px.crop(r, { x: -1, y: -1, width: 3, height: 3 });
  assert.deepEqual([piece.width, piece.height], [2, 2]);
  assert.deepEqual(colors(piece), [RED.join(','), WHITE.join(','), WHITE.join(','), WHITE.join(',')]);
  assert.deepEqual([px.crop(r, { x: 5, y: 0, width: 2, height: 2 }).width, px.crop(r, { x: 1, y: 1, width: 0, height: 3 }).height], [0, 0]);
  assert.deepEqual(px.crop(r, { x: 3, y: 3, width: -2, height: -2 }), px.crop(r, { x: 1, y: 1, width: 2, height: 2 }));

  const stamp = raster(3, 3, BLUE);
  px.fillRect(stamp, { x: 1, y: 1, width: 1, height: 1 }, [0, 0, 0, 0]);
  px.paste(r, stamp, 2, 2);
  assert.deepEqual(at(r, 3, 3), WHITE, 'transparent source pixels are skipped');
  assert.deepEqual([at(r, 2, 2), at(r, 3, 2), at(r, 2, 3)], [BLUE, BLUE, BLUE]);
  px.paste(r, stamp, -2, -2);
  assert.deepEqual(at(r, 0, 0), BLUE);
  assert.deepEqual(at(r, 1, 0), WHITE);
});

test('blit copies every pixel, transparent ones too, clipped to the raster; unionRect bounds two rects', () => {
  const r = raster(3, 3);
  const src = raster(2, 2, BLUE);
  px.fillRect(src, { x: 1, y: 1, width: 1, height: 1 }, [0, 0, 0, 0]);
  px.blit(r, src, 2, 2);
  assert.deepEqual(at(r, 2, 2), BLUE);
  px.blit(r, src, 0, 0);
  assert.deepEqual([at(r, 0, 0), at(r, 1, 0), at(r, 1, 1)], [BLUE, BLUE, [0, 0, 0, 0]]);
  px.blit(r, src, -1, -1);
  assert.deepEqual(at(r, 0, 0), [0, 0, 0, 0]);
  px.blit(r, src, 5, 0);
  assert.deepEqual(px.unionRect({ x: 1, y: 2, width: 2, height: 1 }, { x: 0, y: 4, width: 1, height: 1 }), { x: 0, y: 2, width: 3, height: 3 });
  assert.deepEqual(px.unionRect(null, { x: 1, y: 2, width: 3, height: 4 }), { x: 1, y: 2, width: 3, height: 4 });
});

/** An in-place edit of `doc`'s raster, filling `rect` with `color`, committed as a patch. */
function patchFill(history, rect, color) {
  const r = history.current.raster, before = px.crop(r, rect);
  px.fillRect(r, rect, color);
  const doc = { raster: r, objects: history.current.objects };
  history.commit(doc, { rect, before });
  return doc;
}

test('history undoes and redoes in-place patches and whole-raster replacements in order', () => {
  const original = { raster: raster(4, 4), objects: [] };
  const h = new History(original);
  const painted = patchFill(h, { x: 0, y: 0, width: 2, height: 2 }, RED);
  const filled = patchFill(h, { x: 1, y: 1, width: 3, height: 3 }, BLUE);
  const cropped = { raster: px.crop(filled.raster, { x: 1, y: 1, width: 2, height: 2 }), objects: [] };
  h.commit(cropped);
  const after = colors(cropped.raster);

  assert.deepEqual(h.undo(), {}, 'a replaced raster comes back whole');
  assert.equal(h.current, filled);
  assert.deepEqual([at(h.current.raster, 0, 0), at(h.current.raster, 1, 1), at(h.current.raster, 3, 3)], [RED, BLUE, BLUE]);
  assert.deepEqual(h.undo(), { rect: { x: 1, y: 1, width: 3, height: 3 } }, 'a patch reports the rectangle it changed');
  assert.equal(h.current, painted);
  assert.deepEqual([at(h.current.raster, 1, 1), at(h.current.raster, 3, 3)], [RED, WHITE]);
  assert.ok(h.undo());
  assert.equal(h.current, original);
  assert.ok(colors(h.current.raster).every(c => c === WHITE.join(',')));
  assert.equal(h.undo(), null);

  assert.deepEqual(h.redo(), { rect: { x: 0, y: 0, width: 2, height: 2 } });
  assert.deepEqual([at(h.current.raster, 1, 1), at(h.current.raster, 2, 2)], [RED, WHITE]);
  assert.ok(h.redo() && h.redo());
  assert.equal(h.current, cropped);
  assert.deepEqual(colors(h.current.raster), after);
  assert.deepEqual(at(filled.raster, 3, 3), BLUE, 'the replaced raster holds its last revision');
  assert.equal(h.redo(), null);

  // A new edit after an undo drops the redo.
  h.undo();
  patchFill(h, { x: 3, y: 0, width: 1, height: 1 }, BLACK);
  assert.equal(h.canRedo, false);
});

test('history keeps patches and replaced rasters within its byte limit, oldest first', () => {
  // Each 1×1 patch holds 4 bytes, one side of it at a time; a replaced 4×4 raster, 64.
  const h = new History({ raster: raster(4, 4), objects: [] }, 12);
  for (const x of [0, 1, 2, 3]) patchFill(h, { x, y: 0, width: 1, height: 1 }, RED);
  let undos = 0;
  while (h.undo()) undos++;
  assert.equal(undos, 3);
  assert.deepEqual(at(h.current.raster, 0, 0), RED, 'the oldest patch is gone');
  assert.deepEqual(at(h.current.raster, 1, 0), WHITE);

  const big = new History({ raster: raster(4, 4), objects: [] }, 64);
  big.commit({ raster: raster(2, 2), objects: [] });
  assert.equal(big.canUndo, true, 'a replaced raster at the limit stays');
  patchFill(big, { x: 0, y: 0, width: 1, height: 1 }, RED);
  assert.equal(big.canUndo, true);
  big.undo();
  assert.equal(big.canUndo, false, 'the replaced raster went first once over the limit');
});

test('pieces give back the pixels an edit touched, the first keep of each pixel winning', () => {
  const r = raster(5, 5), original = colors(r), pieces = new Pieces(r);
  // Overlapping segments, each kept just before it is painted, as a brush stroke does.
  assert.deepEqual(pieces.keep({ x: 1, y: 1, width: 2, height: 2 }), { x: 1, y: 1, width: 2, height: 2 });
  px.fillRect(r, { x: 1, y: 1, width: 2, height: 2 }, RED);
  assert.deepEqual(pieces.keep({ x: 2, y: 2, width: 9, height: 9 }), { x: 2, y: 2, width: 3, height: 3 });
  px.fillRect(r, { x: 2, y: 2, width: 3, height: 3 }, BLUE);
  assert.equal(pieces.keep({ x: 7, y: 7, width: 2, height: 2 }), null);

  assert.deepEqual(colors(pieces.before({ x: 0, y: 0, width: 5, height: 5 })), original);
  const inner = pieces.before({ x: 2, y: 2, width: 2, height: 2 });
  assert.deepEqual(colors(inner), Array(4).fill(WHITE.join(',')));
  pieces.restore();
  assert.deepEqual(colors(r), original);
});

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

// The canvas the controller paints is out of scope: a stand-in takes its
// calls, and converts colors as a browser would between sRGB and Display P3
// for the few colors these tests use.
const P3 = new Map([['#ff0000', [234, 51, 35]], ['#00ff00', [117, 251, 76]]]);
const SRGB = new Map([...P3].map(([hex, p3]) => [p3.join(), [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16))]));
const contexts = [];
function fakeContext(options = {}) {
  let last = null;
  const ctx = {
    options, fillStyle: '#000000',
    fillRect() { last = { fill: ctx.fillStyle }; },
    putImageData(image) { last = { image }; },
    getImageData(x, y, w, h, settings = {}) {
      const into = settings.colorSpace ?? options.colorSpace ?? 'srgb';
      let rgb = [0, 0, 0];
      if (last?.fill) {
        const hex = last.fill;
        rgb = into === 'display-p3' ? P3.get(hex) : [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
      } else if (last?.image) {
        const d = Array.from(last.image.data.subarray(0, 3)), from = last.image.colorSpace;
        rgb = from === into ? d : from === 'display-p3' ? SRGB.get(d.join()) : P3.get(`#${d.map(n => n.toString(16).padStart(2, '0')).join('')}`);
      }
      return { data: new Uint8ClampedArray([...rgb, 255]) };
    },
  };
  contexts.push(ctx);
  return new Proxy(ctx, { get: (target, key) => key in target ? target[key] : () => {} });
}
function fakeCanvas() {
  const listeners = {};
  let ctx;
  return {
    width: 0, height: 0, clientHeight: 100, style: {}, listeners,
    getContext(_, options) { return ctx ??= fakeContext(options); },
    addEventListener(type, fn) { listeners[type] = fn; },
    removeEventListener() {},
    getBoundingClientRect: () => ({ left: 0, top: 0 }),
    setPointerCapture() {},
  };
}
globalThis.document = { createElement: fakeCanvas };
globalThis.ImageData = class { constructor(data, width, height, settings) { Object.assign(this, { data, width, height, colorSpace: settings?.colorSpace ?? 'srgb' }); } };
globalThis.requestAnimationFrame = () => 1;
globalThis.cancelAnimationFrame = () => {};
globalThis.getComputedStyle = () => ({ getPropertyValue: () => '' });

const { EditorController } = await load('../viewer/image/controller.ts');
const { imageColors } = await load('../viewer/image/color.ts');
const px = await load('../viewer/image/pixels.ts');

const WHITE = [255, 255, 255, 255];
function raster(width, height, color = WHITE) {
  const r = px.createRaster(width, height);
  px.fillRect(r, { x: 0, y: 0, width, height }, color);
  return r;
}
/** A controller over a white image, wired to a stand-in canvas whose
 * client coordinates are image pixels. */
function editor(format) {
  const ctl = new EditorController(raster(8, 8), format), canvas = fakeCanvas();
  ctl.attach(canvas);
  const pointer = (type, x, y, extra = {}) => canvas.listeners[type]({ isPrimary: true, button: 0, clientX: x, clientY: y, pointerId: 1, preventDefault() {}, ...extra });
  return { ctl, click: (x, y) => { pointer('pointerdown', x, y); pointer('pointerup', x, y); } };
}

test('redo waits while a floating selection is pending, which undo cancels', () => {
  const { ctl } = editor();
  ctl.selectAll();
  ctl.deleteSelected();
  ctl.undo();
  assert.equal(ctl.canRedo, true);

  ctl.selectAll();
  ctl.nudge(1, 0);
  assert.equal(ctl.canRedo, false, 'landing the float would drop the redo step');
  ctl.redo();
  assert.ok(ctl.floating, 'redo leaves the float pending');
  assert.equal(ctl.history.canRedo, true, 'and keeps its step');

  ctl.undo();
  assert.equal(ctl.canRedo, true);
  ctl.redo();
  assert.deepEqual(px.pixel(ctl.doc.raster, 0, 0), [0, 0, 0, 0], 'the erase came back');
});

test('an open label that would change the document is unsaved as it is typed, and a snapshot lands it', () => {
  const { ctl, click } = editor();
  let reports = 0;
  ctl.hooks = { onChange: () => reports++ };
  ctl.setTool('text');
  const saved = ctl.doc;
  click(2, 2);
  assert.ok(ctl.text, 'the label editor is open');
  assert.equal(ctl.holds(saved), true, 'an empty label changes nothing');

  ctl.setText('hi');
  assert.equal(ctl.holds(saved), false);
  assert.equal(reports, 1, 'the host hears the change at once');
  ctl.setText('hi there');
  assert.equal(reports, 1, 'and once per change of state, not per key');
  ctl.setText('  ');
  assert.equal(ctl.holds(saved), true);
  assert.equal(reports, 2);

  ctl.setText('label');
  const mark = ctl.settle();
  assert.equal(ctl.text, null);
  assert.deepEqual(mark.objects.map(s => [s.kind, s.text]), [['text', 'label']]);
  assert.equal(ctl.holds(mark), true);
});

test('swatches are sRGB: pixel tools write them in a Display P3 image\'s space, and the eyedropper reads sRGB back', () => {
  const { ctl, click } = editor({ mime: 'image/png', colorSpace: 'display-p3', keep: [] });
  ctl.setColor('#ff0000');
  ctl.setTool('brush');
  click(0, 0);
  assert.deepEqual(px.pixel(ctl.doc.raster, 0, 0), [234, 51, 35, 255], 'the pencil writes P3 red');

  ctl.setColor('#00ff00');
  ctl.setTool('bucket');
  click(5, 5);
  assert.deepEqual(px.pixel(ctl.doc.raster, 5, 5), [117, 251, 76, 255], 'the fill writes P3 green');

  ctl.setTool('eyedropper');
  click(0, 0);
  assert.equal(ctl.color, '#ff0000', 'picking the pencil\'s pixel gives back its swatch');
  assert.deepEqual(ctl.picked, [255, 0, 0, 255]);
});

test('imageColors passes sRGB through and converts other spaces in a canvas of that space, once per color', () => {
  let made = 0;
  const srgb = imageColors('srgb', () => { made++; return fakeCanvas(); });
  assert.deepEqual(srgb.toImage('#12abef'), [0x12, 0xab, 0xef, 255]);
  assert.deepEqual(srgb.toSrgb([1, 2, 3, 4]), [1, 2, 3, 4]);
  assert.equal(made, 0, 'sRGB needs no canvas');

  const p3 = imageColors('display-p3', () => { made++; return fakeCanvas(); });
  assert.deepEqual(p3.toImage('#ff0000'), [234, 51, 35, 255]);
  assert.equal(contexts.at(-1).options.colorSpace, 'display-p3');
  const ctx = contexts.at(-1), fillRect = ctx.fillRect;
  let count = 0;
  ctx.fillRect = () => { count++; fillRect(); };
  assert.deepEqual(p3.toImage('#ff0000'), [234, 51, 35, 255]);
  assert.equal(count, 0, 'a converted color is cached');
  assert.deepEqual(p3.toSrgb([234, 51, 35, 128]), [255, 0, 0, 128], 'alpha is kept');
  assert.equal(made, 1);
});

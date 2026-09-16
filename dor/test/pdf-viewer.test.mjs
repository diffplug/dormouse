import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasSize, startPdfViewer } from '../viewer/controller.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
class Element extends EventTarget {
  disabled = false;
  hidden = false;
  value = '';
  textContent = '';
  clientWidth = 824;
  attributes = new Map();
  style = { setProperty() {} };
  dataset = {};
  setAttribute(name, value) { this.attributes.set(name, value); }
  getContext() { return {}; }
  replaceChildren() {}
  focus() { this.focused = true; }
  click() { this.dispatchEvent(new Event('click')); }
}
function fixture({ delayTextCancellation = false } = {}) {
  const elements = Object.fromEntries(['status', 'page', 'canvas', 'text', 'page-number', 'password-form', 'password',
    'previous', 'next', 'zoom-out', 'fit', 'zoom-in', 'cancel', 'pages', 'page-count'].map(id => [id, new Element()]));
  const loadingGate = Promise.withResolvers();
  const renders = [];
  const pages = new Map();
  const texts = [];
  const options = [];
  let destroyed = false;
  const loading = { promise: loadingGate.promise, destroy: async () => { destroyed = true; } };
  const pdf = {
    numPages: 3,
    getPage: async number => {
      if (!pages.has(number)) pages.set(number, {
        cleanupCount: 0,
        cleanup() { ++this.cleanupCount; },
        getViewport: ({ scale }) => ({ width: 600 * scale, height: 800 * scale, userUnit: 1 }),
        streamTextContent: () => ({}),
        render: args => {
          const gate = Promise.withResolvers();
          const task = { number, args, promise: gate.promise, done: gate.resolve,
            cancel() { this.cancelled = true; gate.reject(Object.assign(new Error('cancelled'), { name: 'RenderingCancelledException' })); } };
          renders.push(task);
          return task;
        },
      });
      return pages.get(number);
    },
  };
  const pdfjs = {
    GlobalWorkerOptions: {}, PasswordResponses: { INCORRECT_PASSWORD: 2 },
    getDocument: value => { options.push(value); return loading; },
    TextLayer: class {
      gate = Promise.withResolvers();
      constructor() { texts.push(this); }
      render() { return delayTextCancellation ? this.gate.promise : Promise.resolve(); }
      cancel() { this.cancelled = true; }
      settle() { this.gate.resolve(); }
    },
  };
  const document = { getElementById: id => elements[id], body: { dataset: { document: './file/report.pdf' } } };
  const window = Object.assign(new EventTarget(), { location: { href: 'http://127.0.0.1:1234/cap/view' }, devicePixelRatio: 2, setTimeout, clearTimeout });
  const viewer = startPdfViewer(pdfjs, document, window);
  return { elements, loading, loadingGate, pdf, pdfjs, options, renders, pages, texts, viewer, window, destroyed: () => destroyed };
}

test('bounds enormous page bitmaps at both per-axis and total-pixel limits', () => {
  for (const [width, height, dpr] of [[600, 800, 2], [1e6, 1e6, 4], [1e7, 10, 2], [10, 1e7, 2]]) {
    const size = canvasSize(width, height, dpr);
    assert.ok(size.width <= 8192 && size.height <= 8192);
    assert.ok(size.width * size.height <= 16 * 1024 * 1024);
  }
});

test('loads only capability-relative PDF assets, cancels obsolete rendering and navigates/zooms', async () => {
  const f = fixture();
  assert.equal(f.pdfjs.GlobalWorkerOptions.workerSrc, 'http://127.0.0.1:1234/cap/pdfjs/pdf.worker.mjs');
  assert.equal(f.options[0].url, 'http://127.0.0.1:1234/cap/file/report.pdf');
  assert.equal(f.options[0].enableXfa, false);
  f.loadingGate.resolve(f.pdf);
  await tick();
  assert.equal(f.renders[0].number, 1);
  f.elements.next.click();
  await tick();
  assert.equal(f.renders[0].cancelled, true);
  assert.equal(f.renders[1].number, 2);
  f.renders[1].done();
  await tick();
  assert.equal(f.elements.status.textContent, 'Page 2 of 3');
  const originalWidth = f.elements.canvas.width;
  f.elements['zoom-in'].click();
  await tick();
  assert.ok(f.elements.canvas.width > originalWidth);
  f.renders.at(-1).done();
  await tick();
  f.elements.fit.click();
  await tick();
  assert.equal(f.elements.canvas.width, originalWidth);
  f.renders.at(-1).done();
  await tick();
  f.elements['page-number'].value = '999';
  f.elements['page-number'].dispatchEvent(new Event('change'));
  await tick();
  assert.equal(f.renders.at(-1).number, 2);
  f.viewer.cancel();
  await f.viewer.ready;
  assert.equal(f.destroyed(), true);
});

test('keeps loading failures visible and accepts password retries without keeping the entered password', async () => {
  const f = fixture();
  let supplied;
  f.loading.onPassword(password => { supplied = password; }, 2);
  assert.equal(f.elements['password-form'].hidden, false);
  assert.equal(f.elements.status.textContent, 'Incorrect password. Try again.');
  f.elements.password.value = 'secret';
  f.elements['password-form'].dispatchEvent(new Event('submit', { cancelable: true }));
  assert.equal(supplied, 'secret');
  assert.equal(f.elements.password.value, '');
  f.loadingGate.reject(new Error('Invalid PDF structure'));
  await f.viewer.ready;
  assert.equal(f.elements.status.attributes.get('role'), 'alert');
  assert.match(f.elements.status.textContent, /Invalid PDF structure/);
  f.viewer.cancel();
});

test('cancellation prevents a late document load from drawing or replacing its status', async () => {
  const f = fixture();
  f.elements.cancel.click();
  f.loadingGate.resolve(f.pdf);
  await f.viewer.ready;
  assert.equal(f.renders.length, 0);
  assert.equal(f.elements.next.disabled, true);
  assert.match(f.elements.status.textContent, /cancelled/);
  assert.equal(f.destroyed(), true);
});

test('releases a previous page only after cancelled canvas and text work settle', async () => {
  const f = fixture({ delayTextCancellation: true });
  f.loadingGate.resolve(f.pdf);
  await tick();
  f.elements.next.click();
  await tick();
  assert.equal(f.renders[0].cancelled, true);
  assert.equal(f.texts[0].cancelled, true);
  assert.equal(f.pages.get(1).cleanupCount, 0);
  assert.equal(f.renders.length, 1);
  f.texts[0].settle();
  await tick();
  assert.equal(f.pages.get(1).cleanupCount, 1);
  assert.equal(f.renders[1].number, 2);
  f.renders[1].done();
  f.texts[1].settle();
  await tick();
  f.elements.next.click();
  await tick();
  assert.equal(f.pages.get(2).cleanupCount, 1);
  assert.equal(f.renders[2].number, 3);
  f.renders[2].done();
  f.texts[2].settle();
  await tick();
  f.viewer.cancel();
  await tick();
  assert.equal(f.pages.get(3).cleanupCount, 1);
});

test('cleans a stale getPage result before a newer request can reuse that cached page', async () => {
  const f = fixture();
  const page = await f.pdf.getPage(1);
  const gate = Promise.withResolvers();
  let calls = 0;
  f.pdf.getPage = async () => ++calls === 1 ? gate.promise : page;
  f.loadingGate.resolve(f.pdf);
  await tick();
  f.elements.fit.click();
  gate.resolve(page);
  await tick();
  assert.equal(page.cleanupCount, 1);
  assert.equal(f.renders.length, 1);
  f.renders[0].done();
  await tick();
  assert.equal(page.cleanupCount, 1);
  assert.equal(f.elements.status.textContent, 'Page 1 of 3');
  f.viewer.cancel();
  await tick();
  assert.equal(page.cleanupCount, 2);
});

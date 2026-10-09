import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { runInNewContext } from 'node:vm';
import { load } from './bundle.mjs';
import { OUT, recordedHash, tooltipScriptModule } from '../scripts/build-tooltip-script.mjs';
import { editorPage } from '../dist/editor-page.js';

const { placeTip, tipLines, TIP_GAP, TIP_MARGIN } = await load('../viewer/tip-layout.ts');
const { refuseDisabledClick } = await load('../viewer/aria-disabled.ts');

const plain = text => ({ text, key: false });
const key = text => ({ text, key: true });
const viewport = { width: 700, height: 400 };
const box = (left, top, width = 24, height = 24) => ({ left, top, right: left + width, bottom: top + height });

test('reads [k] as a shortcut, as lib does, and a newline as another line', () => {
  assert.deepEqual(tipLines('Undo [Cmd/Ctrl+Z]'), [[plain('Undo '), key('Cmd/Ctrl+Z')]]);
  assert.deepEqual(tipLines('Split [|] or [%]'), [[plain('Split '), key('|'), plain(' or '), key('%')]]);
  assert.deepEqual(tipLines('Arrow [A]\n⇧ snaps to 45°.'), [[plain('Arrow '), key('A')], [plain('⇧ snaps to 45°.')]]);
  assert.deepEqual(tipLines('Reload from disk'), [[plain('Reload from disk')]]);
});

test('reads literal text verbatim, on one line', () => {
  assert.deepEqual(tipLines('report [draft].md', true), [[plain('report [draft].md')]]);
  assert.deepEqual(tipLines('a\nb\r\nc\u2028d', true), [[plain('a b c d')]]);
});

test('spells the bracket keys themselves as [[] and []]', () => {
  assert.deepEqual(tipLines('Pencil size [[] and []]'), [[plain('Pencil size '), key('['), plain(' and '), key(']')]]);
});

test('sits below the control, at the edge on its side of the viewport', () => {
  assert.deepEqual(placeTip(box(10, 4), { width: 120, height: 24 }, viewport), { left: 10, top: 28 + TIP_GAP, above: false });
  // Right of center: the tip's right edge meets the control's.
  assert.deepEqual(placeTip(box(600, 4), { width: 120, height: 24 }, viewport), { left: 624 - 120, top: 28 + TIP_GAP, above: false });
});

test('stays inside the viewport', () => {
  assert.equal(placeTip(box(680, 4, 16), { width: 300, height: 24 }, viewport).left, 696 - 300);
  assert.equal(placeTip(box(0, 4, 4), { width: 300, height: 24 }, viewport).left, TIP_MARGIN);
  // Wider than the viewport: its start stays in view.
  assert.equal(placeTip(box(300, 4), { width: 900, height: 24 }, viewport).left, TIP_MARGIN);
});

test('flips above when there is no room below', () => {
  assert.deepEqual(placeTip(box(10, 370), { width: 120, height: 40 }, viewport), { left: 10, top: 370 - TIP_GAP - 40, above: true });
  // Fits neither side: the roomier one, clamped.
  const tall = placeTip(box(10, 300), { width: 120, height: 390 }, viewport);
  assert.deepEqual(tall, { left: 10, top: TIP_MARGIN, above: true });
});

test('a click on or inside an aria-disabled control never reaches the page', () => {
  const click = disabled => {
    const event = { prevented: false, stopped: false, preventDefault() { this.prevented = true; }, stopImmediatePropagation() { this.stopped = true; },
      target: { closest: selector => (disabled && selector === '[aria-disabled="true"]' ? {} : null) } };
    refuseDisabledClick(event);
    return { prevented: event.prevented, stopped: event.stopped };
  };
  assert.deepEqual(click(true), { prevented: true, stopped: true });
  assert.deepEqual(click(false), { prevented: false, stopped: false });
  // A text node, or a click with no target, is not a control.
  for (const target of [null, {}]) assert.doesNotThrow(() => refuseDisabledClick({ target, preventDefault() { throw new Error('refused'); } }));
});

test('installing tooltips keeps the page\'s aria-disabled controls inert', async () => {
  const listeners = [];
  const target = () => ({ addEventListener: (type, listener, capture) => listeners.push({ type, listener, capture }) });
  const element = () => ({ style: {}, dataset: {}, setAttribute() {}, append() {} });
  const document = { ...target(), body: element(), createElement: element };
  const { TOOLTIP_SCRIPT } = await load('../src/tooltip-script.ts');
  runInNewContext(TOOLTIP_SCRIPT, { document, window: target(), MutationObserver: class {}, performance });
  const clicks = listeners.filter(l => l.type === 'click' && l.capture === true);
  assert.equal(clicks.length, 1);
  let prevented = false;
  clicks[0].listener({ target: { closest: () => ({}) }, preventDefault() { prevented = true; }, stopImmediatePropagation() {} });
  assert.ok(prevented);
});

/** The generated tooltip on a fake page: `hover` rests the mouse on a
 * control, and `shown` is the tip's lines, each `[k]` shortcut in <>, or null. */
async function tooltipPage() {
  const { TOOLTIP_SCRIPT } = await load('../src/tooltip-script.ts');
  class Element {
    constructor() { Object.assign(this, { style: {}, dataset: {}, attributes: {}, hidden: false, isConnected: true, children: [] }); }
    closest() { return this; }
    hasAttribute(name) { return name in this.attributes; }
    getAttribute(name) { return this.attributes[name] ?? null; }
    setAttribute(name, value) { this.attributes[name] = value; }
    removeAttribute(name) { delete this.attributes[name]; }
    getClientRects() { return this.isConnected ? [{}] : []; }
    getBoundingClientRect() { return { left: 0, top: 0, right: 24, bottom: 24 }; }
    contains(other) { return other === this; }
    append(...children) { this.children.push(...children); }
    replaceChildren(...children) { this.children = children; }
  }
  const listeners = {}, timers = [];
  let tip;
  const document = {
    addEventListener: (type, listener) => { listeners[type] = listener; },
    body: new Element(), documentElement: { clientWidth: 800, clientHeight: 600 },
    createElement: () => { const element = new Element(); tip ??= element; return element; },
  };
  runInNewContext(TOOLTIP_SCRIPT, {
    document, window: { addEventListener() {} }, Element, HTMLElement: Element, Node: Element, performance,
    MutationObserver: class { observe() {} disconnect() {} }, setTimeout: run => timers.push(run), clearTimeout() {},
  });
  return {
    control: (tips = {}) => Object.assign(new Element(), tips),
    hover(control, { beforeShow = () => {} } = {}) {
      listeners.pointerover({ pointerType: 'mouse', target: control });
      beforeShow();
      timers.at(-1)();
    },
    shown: () => tip.hidden ? null : tip.children.map(line => line.children.map(c => typeof c === 'string' ? c : `<${c.textContent}>`).join('')),
  };
}

test('a hint\'s [k] is a shortcut; a name, a path, or a title shows verbatim on one line', async () => {
  const cases = [
    [{ dataset: { tip: 'Undo [Cmd/Ctrl+Z]\nOr the toolbar' } }, ['Undo <[Cmd/Ctrl+Z]>', 'Or the toolbar']],
    [{ dataset: { tipText: 'photo[1].png\nnext' } }, ['photo[1].png next']],
    [{ attributes: { title: 'report [draft].md' }, title: 'report [draft].md' }, ['report [draft].md']],
  ];
  for (const [tips, lines] of cases) {
    const page = await tooltipPage(), control = page.control(tips);
    page.hover(control);
    assert.deepEqual(page.shown(), lines);
  }
});

test('a control that leaves the page or hides before its tip shows gets none', async () => {
  for (const change of [control => { control.isConnected = false; }, control => { control.getClientRects = () => []; }, control => { control.dataset = {}; }]) {
    const page = await tooltipPage(), control = page.control({ dataset: { tip: 'Edit' } });
    page.hover(control, { beforeShow: () => change(control) });
    assert.equal(page.shown(), null);
  }
});

test('the Monaco page tips its file name verbatim', () => {
  assert.match(editorPage('report [draft].md'), /<span id="filename" data-tip-text="report \[draft\]\.md">/);
});

test('the folder viewer inlines the tooltip built from the current sources', async () => {
  // Only the sources count: another esbuild may minify them differently.
  assert.equal(recordedHash(await readFile(OUT, 'utf8')), recordedHash(await tooltipScriptModule()), 'src/tooltip-script.ts is stale: run node scripts/build-tooltip-script.mjs');
});

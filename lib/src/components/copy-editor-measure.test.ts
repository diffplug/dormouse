/**
 * @vitest-environment jsdom
 *
 * jsdom lays nothing out: each part's box is stubbed, and the height probe's
 * height follows the width last written to it, as wrapped lines would.
 */
import { expect, it } from 'vitest';
import { createHeightMeasurer, measureChromeWidth, measureNaturalWidth, type CopyEditorParts } from './copy-editor-measure';

function box(element: HTMLElement, sizes: Partial<Record<'offsetWidth' | 'clientWidth' | 'offsetHeight' | 'clientHeight', () => number>>): HTMLElement {
  for (const [key, get] of Object.entries(sizes)) Object.defineProperty(element, key, { get, configurable: true });
  return element;
}

function parts(): CopyEditorParts & { heightReads: number[] } {
  const heightReads: number[] = [];
  const heightProbe = document.createElement('div');
  box(heightProbe, {
    // 2000px of text wrapped into 18px lines at the probe's width.
    offsetHeight: () => {
      const width = parseFloat(heightProbe.style.width);
      heightReads.push(width);
      return Math.ceil(2000 / width) * 18;
    },
  });
  const widthProbe = document.createElement('div');
  widthProbe.getBoundingClientRect = () => ({ width: 640.4 }) as DOMRect;
  const chromeProbe = document.createElement('div');
  chromeProbe.getBoundingClientRect = () => ({ width: 480.2 }) as DOMRect;
  const essentialProbe = document.createElement('div');
  essentialProbe.getBoundingClientRect = () => ({ width: 300.5 }) as DOMRect;
  return {
    root: box(document.createElement('div'), { offsetWidth: () => 802, clientWidth: () => 800, offsetHeight: () => 302, clientHeight: () => 300 }),
    header: box(document.createElement('div'), { offsetHeight: () => 50 }),
    preview: box(document.createElement('div'), { offsetWidth: () => 700, clientWidth: () => 688 }),
    footer: box(document.createElement('div'), { offsetHeight: () => 24 }),
    widthProbe,
    chromeProbe,
    essentialProbe,
    heightProbe,
    heightReads,
  };
}

it('measures the natural width as the probe, the preview gutter, and the root borders', () => {
  expect(measureNaturalWidth(parts())).toBe(641 + 12 + 2);
});

it('measures the chrome as its probe and the root borders, with no preview gutter', () => {
  const p = parts();
  expect(measureChromeWidth(p, p.chromeProbe)).toBe(481 + 2);
  expect(measureChromeWidth(p, p.essentialProbe)).toBe(301 + 2);
});

it('lays the height probe out at the width the root gives its preview, once per width', () => {
  const p = parts();
  const heightAt = createHeightMeasurer(p);
  // 400px wide is 398px inside the borders: six 18px lines.
  expect(heightAt(400)).toBe(50 + 24 + 6 * 18 + 2);
  expect(p.heightProbe.style.width).toBe('398px');
  expect(heightAt(400.2)).toBe(50 + 24 + 6 * 18 + 2);
  expect(heightAt(1002)).toBe(50 + 24 + 2 * 18 + 2);
  expect(p.heightReads).toEqual([398, 1000]);
});

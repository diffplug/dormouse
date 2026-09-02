/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { encode } from 'uqr';

import { QrCode } from './QrCode';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const URL_UNDER_TEST = 'https://ned-mac.tail9c2f1.ts.net/#pair?1.3PkQ8sV2mYb1hZr7Lw0c';

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

async function render() {
  await act(async () => {
    root.render(<QrCode value={URL_UNDER_TEST} label="Setup code" />);
  });
  return container.querySelector('svg')!;
}

describe('QrCode', () => {
  it('draws every dark module the encoder produced, and only those', async () => {
    const svg = await render();
    // The matrix is the encoder's; what this component owns is the walk that
    // turns it into one path, and a walk that drops or shifts a run is a code
    // that fails silently — nothing renders wrong, it just does not scan.
    const expected = encode(URL_UNDER_TEST, { border: 4, ecc: 'M' });
    const dark = expected.data.flat().filter(Boolean).length;

    const runs = [...svg.querySelector('path')!.getAttribute('d')!.matchAll(/h(\d+)v1/g)];
    expect(runs.reduce((total, [, run]) => total + Number(run), 0)).toBe(dark);
    expect(svg.getAttribute('viewBox')).toBe(`0 0 ${expected.size} ${expected.size}`);
  });

  it('carries its own light ground, because a camera reads it and not a person', async () => {
    const svg = await render();
    // Scanners expect dark-on-light and no theme token can promise either the
    // polarity or the contrast in both light and dark (see the module note).
    expect(svg.querySelector('rect')!.getAttribute('fill')).toBe('#ffffff');
    expect(svg.querySelector('path')!.getAttribute('fill')).toBe('#000000');
  });

  it('surrounds the code with the quiet zone scanners require', async () => {
    const svg = await render();
    // Four modules on every side; `uqr` defaults to one, which reads as a code
    // that only scans depending on what happens to sit next to it.
    const size = Number(svg.getAttribute('viewBox')!.split(' ')[2]);
    const d = svg.querySelector('path')!.getAttribute('d')!;
    const rows = [...d.matchAll(/M(\d+) (\d+)h/g)].map(([, x, y]) => [Number(x), Number(y)]);
    expect(Math.min(...rows.map(([x]) => x))).toBeGreaterThanOrEqual(4);
    expect(Math.min(...rows.map(([, y]) => y))).toBeGreaterThanOrEqual(4);
    expect(Math.max(...rows.map(([, y]) => y))).toBeLessThanOrEqual(size - 5);
  });
});

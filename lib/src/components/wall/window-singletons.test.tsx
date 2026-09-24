/**
 * @vitest-environment jsdom
 *
 * Two hooks a Wall mounts that own WINDOW-level machinery — the alarm
 * delivery performer and the dynamic palette — so N mounted Walls must still run one each
 * (docs/specs/layout.md → "Workspaces").
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAlertDelivery } from './use-alert-delivery';
import { useDynamicPalette } from '../../lib/themes/use-dynamic-palette';

const stopDelivery = vi.fn();
const startDelivery = vi.fn(() => stopDelivery);
vi.mock('../../lib/alert-delivery', () => ({ startAlertDelivery: () => startDelivery() }));
vi.mock('../../lib/themes/dynamic-palette', () => ({
  computeDynamicPalette: () => ({ '--color-door-bg': 'rgb(1, 2, 3)' }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let observers: number;

function Consumer() {
  useAlertDelivery();
  useDynamicPalette();
  return null;
}

beforeEach(() => {
  startDelivery.mockClear();
  stopDelivery.mockClear();
  observers = 0;
  class CountingObserver {
    constructor() { observers += 1; }
    observe() {}
    disconnect() {}
  }
  vi.stubGlobal('MutationObserver', CountingObserver);
  Object.defineProperty(HTMLCanvasElement.prototype, 'getContext', {
    configurable: true,
    value: vi.fn(() => ({})),
  });
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('window-singleton Wall hooks', () => {
  it('arms once for N Walls and disarms only when the last one goes', async () => {
    await act(async () => { root.render(<><Consumer /><Consumer /><Consumer /></>); });
    // One delivery performer (it publishes every Workspace's policy and clears
    // every Session's speech state) and one palette observer for the document.
    expect(startDelivery).toHaveBeenCalledTimes(1);
    expect(observers).toBe(1);
    expect(document.body.style.getPropertyValue('--color-door-bg')).toBe('rgb(1, 2, 3)');

    // Dropping one Wall must not silence the survivors or strip the variables.
    await act(async () => { root.render(<><Consumer /></>); });
    expect(stopDelivery).not.toHaveBeenCalled();
    expect(document.body.style.getPropertyValue('--color-door-bg')).toBe('rgb(1, 2, 3)');

    await act(async () => { root.render(<></>); });
    expect(stopDelivery).toHaveBeenCalledTimes(1);
    expect(document.body.style.getPropertyValue('--color-door-bg')).toBe('');
  });
});

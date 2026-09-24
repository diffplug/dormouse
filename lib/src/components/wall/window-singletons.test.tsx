/**
 * @vitest-environment jsdom
 *
 * Two hooks a Wall mounts that own WINDOW-level machinery — the spoken-alarm
 * watcher and the dynamic palette — so N mounted Walls must still run one each
 * (docs/specs/layout.md → "Workspaces").
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useAlertSpeech } from './use-alert-speech';
import { useDynamicPalette } from '../../lib/themes/use-dynamic-palette';

const stopSpeech = vi.fn();
const startSpeech = vi.fn(() => stopSpeech);
vi.mock('../../lib/alert-speech', () => ({ startAlertSpeech: () => startSpeech() }));
vi.mock('../../lib/themes/dynamic-palette', () => ({
  computeDynamicPalette: () => ({ '--color-door-bg': 'rgb(1, 2, 3)' }),
}));

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;
let observers: number;

function Consumer() {
  useAlertSpeech();
  useDynamicPalette();
  return null;
}

beforeEach(() => {
  startSpeech.mockClear();
  stopSpeech.mockClear();
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
    // One spoken-alarm watcher (it installs a global handler and clears every
    // Session's speech state) and one palette observer for the document.
    expect(startSpeech).toHaveBeenCalledTimes(1);
    expect(observers).toBe(1);
    expect(document.body.style.getPropertyValue('--color-door-bg')).toBe('rgb(1, 2, 3)');

    // Dropping one Wall must not silence the survivors or strip the variables.
    await act(async () => { root.render(<><Consumer /></>); });
    expect(stopSpeech).not.toHaveBeenCalled();
    expect(document.body.style.getPropertyValue('--color-door-bg')).toBe('rgb(1, 2, 3)');

    await act(async () => { root.render(<></>); });
    expect(stopSpeech).toHaveBeenCalledTimes(1);
    expect(document.body.style.getPropertyValue('--color-door-bg')).toBe('');
  });
});

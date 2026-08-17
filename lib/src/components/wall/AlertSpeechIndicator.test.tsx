/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  clearAllAlertSpeechStates,
  setAlertSpeechState,
} from '../../lib/alert-speech-state';
import { AlertSpeechIndicator } from './AlertSpeechIndicator';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  clearAllAlertSpeechStates();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AlertSpeechIndicator sessionId="pty-1" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearAllAlertSpeechStates();
});

/** The ring layer is the top-level sibling that is not the labelled wash layer. */
function ringLayer(): HTMLElement | null {
  return container.querySelector<HTMLElement>(':scope > div:not([data-alert-speech-state])');
}

describe('AlertSpeechIndicator', () => {
  it('renders a loud animated SPEAKING state over the whole Pane', () => {
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    const wash = container.querySelector<HTMLElement>('[data-alert-speech-state="speaking"]');
    expect(wash).not.toBeNull();
    expect(wash?.textContent).toContain('SPEAKING');
    expect(wash?.className).toContain('animate-speech-alarm-pulse');
    expect(wash?.getAttribute('aria-label')).toBe('Terminal is speaking');
    expect(ringLayer()?.className).toContain('inset_0_0_0_5px');
  });

  it('keeps a static SPOKEN treatment until the state is cleared', () => {
    act(() => setAlertSpeechState('pty-1', 'spoken'));

    const wash = container.querySelector<HTMLElement>('[data-alert-speech-state="spoken"]');
    expect(wash?.textContent).toContain('SPOKEN');
    expect(wash?.className).not.toContain('animate-speech-alarm-pulse');
    expect(ringLayer()?.className).toContain('inset_0_0_0_3px');
    expect(ringLayer()?.className).not.toContain('animate-speech-alarm-pulse');

    act(() => clearAllAlertSpeechStates());
    expect(container.querySelector('[data-alert-speech-state]')).toBeNull();
  });

  /**
   * `.lath-leaf-header` is `position: relative; z-index: 20`, so it traps its own
   * popovers — context menu, title candidates, TODO preview, rename warning — at
   * z=20 among the leaf's children no matter how high their own z-index goes.
   * The opaque label chip and the tinting wash must therefore stay BELOW that,
   * while the perimeter ring (which covers only the leaf's edge) stays above so
   * the treatment still outlines the whole Pane.
   */
  it('splits the layers around the header so popovers stay legible', () => {
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    const wash = container.querySelector<HTMLElement>('[data-alert-speech-state="speaking"]');
    expect(wash?.className).toContain('z-[19]');
    expect(wash?.className).toContain('bg-alarm-vs-terminal/20');
    // The chip lives in the wash layer, under the header's popovers.
    expect(wash?.querySelector('span')?.textContent).toBe('SPEAKING');
    expect(ringLayer()?.className).toContain('z-[25]');
    // The ring tints nothing — it is an inset border, not a fill.
    expect(ringLayer()?.className).not.toContain('bg-alarm-vs-terminal/');
  });

  it('never intercepts pointer or focus routing', () => {
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    for (const layer of container.querySelectorAll<HTMLElement>(':scope > div')) {
      expect(layer.className).toContain('pointer-events-none');
    }
  });
});

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
   * The wash must stay below `.lath-leaf-header` (`z-index: 20`) so it never
   * tints the header band — `--color-alarm-vs-terminal` is picked against the
   * terminal body and has no contrast guarantee there — nor the `z-20`
   * mouse-override banner. The ring covers only the leaf's edge, so it can sit
   * above and still outline the whole Pane.
   */
  it('keeps the wash below the header and the ring above it', () => {
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    const wash = container.querySelector<HTMLElement>('[data-alert-speech-state="speaking"]');
    expect(wash?.className).toContain('z-[19]');
    expect(wash?.className).toContain('bg-alarm-vs-terminal/20');
    expect(ringLayer()?.className).toContain('z-[25]');
    // The ring tints nothing — it is an inset border, not a fill.
    expect(ringLayer()?.className).not.toContain('bg-alarm-vs-terminal/');
  });

  /**
   * `spoken` lasts until the ring is attended, which is unbounded, so its wash
   * is lighter than the speaking one — present enough to read as an unhandled
   * alarm, light enough not to fight terminal text for that whole window.
   */
  it('keeps a lighter wash for the unbounded SPOKEN window', () => {
    act(() => setAlertSpeechState('pty-1', 'spoken'));

    const wash = container.querySelector<HTMLElement>('[data-alert-speech-state="spoken"]');
    expect(wash?.className).toContain('bg-alarm-vs-terminal/10');
    expect(ringLayer()?.className).toContain('inset_0_0_0_3px');
  });

  it('never intercepts pointer or focus routing', () => {
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    for (const layer of container.querySelectorAll<HTMLElement>(':scope > div')) {
      expect(layer.className).toContain('pointer-events-none');
    }
  });
});

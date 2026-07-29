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

describe('AlertSpeechIndicator', () => {
  it('renders a loud animated SPEAKING state over the whole Pane', () => {
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    const indicator = container.querySelector<HTMLElement>('[data-alert-speech-state="speaking"]');
    expect(indicator).not.toBeNull();
    expect(indicator?.textContent).toContain('SPEAKING');
    expect(indicator?.className).toContain('animate-speech-alarm-pulse');
    expect(indicator?.className).toContain('inset_0_0_0_5px');
    expect(indicator?.getAttribute('aria-label')).toBe('Terminal is speaking');
  });

  it('keeps a static SPOKEN treatment until the state is cleared', () => {
    act(() => setAlertSpeechState('pty-1', 'spoken'));

    const indicator = container.querySelector<HTMLElement>('[data-alert-speech-state="spoken"]');
    expect(indicator?.textContent).toContain('SPOKEN');
    expect(indicator?.className).not.toContain('animate-speech-alarm-pulse');
    expect(indicator?.className).toContain('inset_0_0_0_3px');

    act(() => clearAllAlertSpeechStates());
    expect(container.querySelector('[data-alert-speech-state]')).toBeNull();
  });
});

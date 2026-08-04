/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Door } from './Door';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('Door spoken-alarm state', () => {
  it('inverts and animates the whole Door while its Session is speaking', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" todo speechState="speaking" />,
    ));

    const door = container.querySelector<HTMLButtonElement>('[data-alert-speech-state="speaking"]');
    expect(door?.className).toContain('bg-alarm-vs-door');
    expect(door?.className).toContain('animate-speech-alarm-pulse');
    expect(door?.textContent).toContain('SPEAKING');
    expect(door?.textContent).not.toContain('TODO');
    expect(door?.getAttribute('aria-label')).toBe('build-server, speaking');
  });

  it('shows a static high-contrast SPOKEN label afterwards', () => {
    act(() => root.render(
      <Door title="build-server" status="ALERT_RINGING" speechState="spoken" />,
    ));

    const door = container.querySelector<HTMLButtonElement>('[data-alert-speech-state="spoken"]');
    expect(door?.className).toContain('inset_0_0_0_2px');
    expect(door?.className).not.toContain('animate-speech-alarm-pulse');
    expect(door?.textContent).toContain('SPOKEN');
  });
});

/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cfg } from '../../cfg';
import {
  clearAllAlertSpeechStates,
  setAlertSpeechState,
} from '../../lib/alert-speech-state';
import type { AlertEpisode } from '../../lib/alert-episode';
import { clearTerminalActivity, setTerminalActivity } from '../../lib/session-activity-store';
import { AlertRingIndicator } from './AlertRingIndicator';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

/** The store hydrates a missing episode itself; a test that needs a stable id says so. */
function ring(episode?: AlertEpisode): void {
  act(() => setTerminalActivity('pty-1', { status: 'ALERT_RINGING', episode }));
}

beforeEach(() => {
  clearAllAlertSpeechStates();
  clearTerminalActivity();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => root.render(<AlertRingIndicator sessionId="pty-1" />));
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  clearAllAlertSpeechStates();
  clearTerminalActivity();
  cfg.alert.ringingPaused = false;
});

/** Exact class tokens: `animate-alarm-pulse` is a prefix of the burst class. */
function classes(el: Element | null | undefined): string[] {
  return el?.className.split(/\s+/).filter(Boolean) ?? [];
}

function ringLayer(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-alert-ring-perimeter]');
}

function washLayer(): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-alert-ring-wash]');
}

function indicator(state: string): HTMLElement | null {
  return container.querySelector<HTMLElement>(`[data-alert-ring-state="${state}"]`);
}

describe('AlertRingIndicator', () => {
  it('renders nothing for a Session that is not ringing', () => {
    expect(container.querySelector('[data-alert-ring-state]')).toBeNull();

    // Speech without a ring cannot happen, and the ring is the gate either way.
    act(() => setAlertSpeechState('pty-1', 'speaking'));
    expect(container.querySelector('[data-alert-ring-state]')).toBeNull();
  });

  it('wears the unlabelled treatment for a plain ring', () => {
    ring();

    const wash = indicator('ringing');
    expect(wash).not.toBeNull();
    expect(wash?.getAttribute('aria-label')).toBe('Terminal needs attention');
    expect(wash?.textContent).toBe('');
    expect(washLayer()?.className).toContain('opacity-10');
    expect(ringLayer()?.className).toContain('inset_0_0_0_3px');
    expect(classes(ringLayer())).toContain('motion-safe:animate-alarm-pulse-burst');
  });

  it('drops the whole treatment when the ring clears', () => {
    ring();
    act(() => setTerminalActivity('pty-1', { status: 'NOTHING_TO_SHOW' }));
    expect(container.querySelector('[data-alert-ring-state]')).toBeNull();
  });

  it('renders a loud animated SPEAKING state over the whole Pane', () => {
    ring();
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    const wash = indicator('speaking');
    expect(wash).not.toBeNull();
    expect(wash?.textContent).toContain('SPEAKING');
    expect(wash?.getAttribute('aria-label')).toBe('Terminal is speaking');
    expect(ringLayer()?.className).toContain('inset_0_0_0_5px');
    // The utterance owns the motion; the arrival burst does not stack on it.
    expect(classes(ringLayer())).toContain('motion-safe:animate-alarm-pulse');
    expect(classes(ringLayer())).not.toContain('motion-safe:animate-alarm-pulse-burst');
  });

  /**
   * `spoken` lasts until the ring is attended, which is unbounded, so it goes
   * static and keeps a wash lighter than the speaking one — present enough to
   * read as an unhandled alarm, light enough not to fight terminal text for that
   * whole window.
   */
  it('keeps a static, lighter SPOKEN treatment until the state is cleared', () => {
    ring();
    act(() => setAlertSpeechState('pty-1', 'spoken'));

    const wash = indicator('spoken');
    expect(wash?.textContent).toContain('SPOKEN');
    expect(washLayer()?.className).toContain('bg-alarm-vs-terminal');
    expect(washLayer()?.className).toContain('opacity-10');
    expect(washLayer()?.className).not.toContain('bg-alarm-vs-terminal/');
    expect(ringLayer()?.className).toContain('inset_0_0_0_3px');
    expect(classes(ringLayer()).some(c => c.includes('animate-'))).toBe(false);

    act(() => clearAllAlertSpeechStates());
    expect(indicator('ringing')).not.toBeNull();
  });

  /**
   * The burst is the summons, and the episode is what the alert sinks already
   * treat as one summons: a second source joining the ring inside it enriches
   * rather than re-summons, so only a fresh episode may replay.
   */
  it('replays the burst for a new episode and not for a re-emit inside one', () => {
    const first: AlertEpisode = { id: 'episode-1', startedAt: Date.now() };
    ring(first);
    const before = ringLayer();

    act(() => setTerminalActivity('pty-1', { status: 'ALERT_RINGING', episode: first, todo: true }));
    expect(ringLayer()).toBe(before);

    ring({ id: 'episode-2', startedAt: Date.now() });
    expect(ringLayer()).not.toBe(before);
  });

  /** A remount inside an episode starts the CSS clock where the episode did, so a
   *  burst that already expired stays expired. */
  it('runs the burst off the episode clock', () => {
    ring({ id: 'episode-old', startedAt: Date.now() - 60_000 });
    expect(Number.parseInt(ringLayer()!.style.animationDelay, 10)).toBeLessThan(-59_000);
  });

  it('suppresses the burst and its dead clock under the Chromatic freeze', () => {
    cfg.alert.ringingPaused = true;
    ring();

    expect(classes(ringLayer()).some(c => c.includes('animate-'))).toBe(false);
    expect(ringLayer()?.style.animationDelay).toBe('');
    // The static treatment survives the freeze.
    expect(ringLayer()?.className).toContain('inset_0_0_0_3px');
  });

  /**
   * The wash must stay below `.lath-leaf-header` (`z-index: 20`) so it never
   * tints the header band — `--color-alarm-vs-terminal` is picked against the
   * terminal body and has no contrast guarantee there — nor the `z-20`
   * mouse-override banner. The ring covers only the leaf's edge, so it can sit
   * above and still outline the whole Pane.
   */
  it('keeps the wash below the header and the ring above it', () => {
    ring();
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    expect(indicator('speaking')?.className).toContain('z-[19]');
    expect(washLayer()?.className).toContain('bg-alarm-vs-terminal');
    expect(washLayer()?.className).toContain('opacity-20');
    expect(washLayer()?.className).toContain('rounded-t-lg');
    expect(washLayer()?.className).toContain('rounded-b-lg');
    // Tailwind's color-opacity modifiers require color-mix(), which is absent
    // from the standalone Safari 15 / Chrome 105 targets.
    expect(washLayer()?.className).not.toContain('bg-alarm-vs-terminal/');
    expect(ringLayer()?.className).toContain('z-[25]');
    // The ring tints nothing — it is an inset border, not a fill.
    expect(ringLayer()?.className).not.toContain('bg-alarm-vs-terminal/');
    // Only the ring animates, so an alarming Pane composites one layer, not two.
    expect(classes(indicator('speaking')).some(c => c.includes('animate-'))).toBe(false);
  });

  it('never intercepts pointer or focus routing', () => {
    ring();
    act(() => setAlertSpeechState('pty-1', 'speaking'));

    for (const layer of container.querySelectorAll<HTMLElement>(':scope > div')) {
      expect(layer.className).toContain('pointer-events-none');
    }
  });
});

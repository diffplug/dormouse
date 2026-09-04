/** @vitest-environment jsdom */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { AlertBell } from './AlertBell';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

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

const bell = () => container.querySelector('svg');

// `docs/specs/alert.md` -> Pane Header. The class assertion is the premise: it
// is identical across rings, so only the remount can restart the burst.
it('replaces the icon when the ring counter advances', async () => {
  await act(async () => root.render(<AlertBell status="ALERT_RINGING" ringSeq={1} size={14} />));
  const first = bell();
  expect(first?.getAttribute('class')).toContain('animate-bell-ring');

  await act(async () => root.render(<AlertBell status="ALERT_RINGING" ringSeq={2} size={14} />));
  const second = bell();
  expect(second).not.toBe(first);
  expect(second?.getAttribute('class')).toBe(first?.getAttribute('class'));
});

// Re-renders that are not a new latch must leave the animation alone, or a burst
// restarts on every unrelated store commit.
it('keeps the icon across a re-render at the same ring counter', async () => {
  await act(async () => root.render(<AlertBell status="ALERT_RINGING" ringSeq={1} size={14} />));
  const first = bell();

  await act(async () => root.render(<AlertBell status="ALERT_RINGING" ringSeq={1} size={14} className="shrink-0" />));
  expect(bell()).toBe(first);
});

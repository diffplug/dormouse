/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresenceTracker, type PresenceTracker } from './presence';
import type { EngagementLapse } from './alert-manager';

const TIMEOUT = 15_000;

let tracker: PresenceTracker;
let timeoutMs: number;
let focused: boolean;
let visibility: DocumentVisibilityState;
let transitions: Array<[boolean, EngagementLapse | undefined]>;

beforeEach(() => {
  vi.useFakeTimers();
  timeoutMs = TIMEOUT;
  focused = true;
  visibility = 'visible';
  vi.spyOn(document, 'hasFocus').mockImplementation(() => focused);
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  transitions = [];
  tracker = createPresenceTracker({
    timeoutMs: () => timeoutMs,
    onChange: (present, lapse) => transitions.push([present, lapse]),
  });
});

afterEach(() => {
  tracker.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

function input(type: string): void {
  window.dispatchEvent(new Event(type));
}

describe('presence', () => {
  it('starts absent and arrives on the first input', () => {
    expect(tracker.present).toBe(false);
    input('keydown');
    expect(tracker.present).toBe(true);
    expect(transitions).toEqual([[true, undefined]]);
  });

  it.each(['keydown', 'pointerdown', 'pointermove', 'wheel', 'compositionupdate'])('counts %s as input', (type) => {
    input(type);
    expect(tracker.present).toBe(true);
  });

  it('lapses as idle one timeout after the last input', () => {
    input('keydown');
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(tracker.present).toBe(true);
    vi.advanceTimersByTime(1);
    expect(transitions).toEqual([[true, undefined], [false, 'idle']]);
  });

  it('stays present while the mouse keeps moving, with no typing at all', () => {
    input('keydown');
    for (let t = 0; t < 60_000; t += 5_000) {
      vi.advanceTimersByTime(5_000);
      input('pointermove');
    }
    expect(tracker.present).toBe(true);
    expect(transitions).toEqual([[true, undefined]]);
  });

  it('sees input a handler below stops, since it listens in the capture phase', () => {
    const target = document.createElement('div');
    document.body.appendChild(target);
    target.addEventListener('keydown', (event) => event.stopPropagation());
    try {
      target.dispatchEvent(new Event('keydown', { bubbles: true }));
      expect(tracker.present).toBe(true);
    } finally {
      target.remove();
    }
  });

  it('leaves on a real window blur, but not when an iframe Surface takes focus', () => {
    input('keydown');
    // An iframe inside the document took focus: the document still has it.
    input('blur');
    expect(tracker.present).toBe(true);

    focused = false;
    input('blur');
    expect(transitions).toEqual([[true, undefined], [false, 'leave']]);
    // No idle lapse follows the leave.
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(transitions).toHaveLength(2);
  });

  it('leaves when hidden and comes back when shown', () => {
    input('keydown');
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(transitions.at(-1)).toEqual([false, 'leave']);

    visibility = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(tracker.present).toBe(true);
  });

  it('ignores input reaching a window that does not have focus', () => {
    focused = false;
    input('pointermove');
    expect(tracker.present).toBe(false);
    focused = true;
    input('focus');
    expect(tracker.present).toBe(true);
  });

  it('applies a shortened timeout from the last input once refreshed', () => {
    input('keydown');
    vi.advanceTimersByTime(4_000);
    timeoutMs = 5_000;
    tracker.refresh();
    vi.advanceTimersByTime(999);
    expect(tracker.present).toBe(true);
    vi.advanceTimersByTime(1);
    expect(transitions.at(-1)).toEqual([false, 'idle']);
  });

  it('stops listening once disposed', () => {
    tracker.dispose();
    input('keydown');
    expect(tracker.present).toBe(false);
  });
});

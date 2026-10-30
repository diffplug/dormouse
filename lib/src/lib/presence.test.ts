/** @vitest-environment jsdom */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createPresenceTracker, type PresenceTracker } from './presence';

const TIMEOUT = 15_000;

let tracker: PresenceTracker;
let timeoutMs: number;
let focused: boolean;
let visibility: DocumentVisibilityState;
let transitions: boolean[];

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
    onChange: (present) => transitions.push(present),
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
    expect(transitions).toEqual([true]);
  });

  it.each(['keydown', 'pointerdown', 'pointermove', 'wheel', 'compositionupdate'])('counts %s as input', (type) => {
    input(type);
    expect(tracker.present).toBe(true);
  });

  it('goes absent one timeout after the last input', () => {
    input('keydown');
    vi.advanceTimersByTime(TIMEOUT - 1);
    expect(tracker.present).toBe(true);
    vi.advanceTimersByTime(1);
    expect(transitions).toEqual([true, false]);
  });

  it('stays present while the mouse keeps moving, with no typing at all', () => {
    input('keydown');
    for (let t = 0; t < 60_000; t += 5_000) {
      vi.advanceTimersByTime(5_000);
      input('pointermove');
    }
    expect(tracker.present).toBe(true);
    expect(transitions).toEqual([true]);
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
    expect(transitions).toEqual([true, false]);
    // No idle lapse follows the leave.
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(transitions).toHaveLength(2);
  });

  it('never goes idle while an iframe Surface holds focus, whose input never reaches this window', () => {
    const frame = document.createElement('iframe');
    const activeElement = vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    input('keydown');
    input('blur');
    vi.advanceTimersByTime(TIMEOUT * 2);
    expect(transitions).toEqual([true]);

    // Focus back in the document: the idle clock runs from the frame's last check.
    activeElement.mockReturnValue(document.body);
    vi.advanceTimersByTime(TIMEOUT);
    expect(transitions).toEqual([true, false]);
  });

  it('leaves at the next deadline when the window loses focus while an iframe holds it', () => {
    const frame = document.createElement('iframe');
    vi.spyOn(document, 'activeElement', 'get').mockReturnValue(frame);
    input('keydown');
    // No blur reaches this window: it already blurred into the frame.
    focused = false;
    vi.advanceTimersByTime(TIMEOUT);
    expect(transitions).toEqual([true, false]);
  });

  it('leaves when hidden and comes back when shown', () => {
    input('keydown');
    visibility = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(transitions.at(-1)).toEqual(false);

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
    expect(transitions.at(-1)).toEqual(false);
  });

  it('stops listening once disposed', () => {
    tracker.dispose();
    input('keydown');
    expect(tracker.present).toBe(false);
  });
});

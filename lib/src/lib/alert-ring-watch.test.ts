import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import { watchUnattendedRings } from './alert-ring-watch';
import { clearPrimedActivity, primeActivity } from './session-activity-store';
import type { SessionStatus } from './activity-monitor';

const DELAY_MS = 10_000;

/** Session ids handed to the sink, in order. */
let fired: string[];
let stop: (() => void) | null = null;
let enabled = true;
let delayMs = DELAY_MS;

/** Drive one Session's projected status through the activity store. */
function setStatus(id: string, status: SessionStatus): void {
  primeActivity(id, { status });
}

/**
 * Ring a Session the store already knows about. A real pane is in the activity
 * store from the moment it is created and only reaches ALERT_RINGING later, so
 * a ring is always a transition from some earlier status — which is exactly
 * what the watcher keys on.
 */
function ring(id: string): void {
  setStatus(id, 'NOTHING_TO_SHOW');
  setStatus(id, 'ALERT_RINGING');
}

/** Start the watcher after any pre-existing state has been staged. */
function start(): void {
  stop = watchUnattendedRings({
    enabled: () => enabled,
    delayMs: () => delayMs,
    fire: (id) => fired.push(id),
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  fired = [];
  enabled = true;
  delayMs = DELAY_MS;
  clearPrimedActivity();
});

afterEach(() => {
  stop?.();
  stop = null;
  clearPrimedActivity();
  vi.useRealTimers();
});

/**
 * The machine behind every alarm sink (`docs/specs/alert.md` -> Alarm
 * settings). Spoken alarms and push notifications share it, so these are the
 * rules both inherit; each sink's own test covers only its payload and its
 * settings field.
 */
describe('watchUnattendedRings', () => {
  it('fires once the delay elapses with the ring unattended', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(DELAY_MS - 1);
    expect(fired).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(fired).toEqual(['pty-1']);
  });

  it('cancels when the user attends before the delay elapses', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(DELAY_MS - 1);
    setStatus('pty-1', 'NOTHING_TO_SHOW');

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('cancels when the pane is killed during the delay', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(DELAY_MS - 1);
    clearPrimedActivity('pty-1');

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('does not schedule anything while the sink is disabled', () => {
    enabled = false;
    start();
    ring('pty-1');

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('drops a scheduled fire if the sink is switched off during the delay', () => {
    start();
    ring('pty-1');

    vi.advanceTimersByTime(DELAY_MS - 1);
    enabled = false;

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('fires exactly once per ring, not once per store notification', () => {
    start();
    ring('pty-1');
    // Unrelated churn in the store — a rerender, a TODO toggle, another pane.
    primeActivity('pty-1', { status: 'ALERT_RINGING', todo: true });
    setStatus('pty-2', 'BUSY');

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual(['pty-1']);
  });

  it('fires again after a ring is cleared and a fresh one arrives', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(DELAY_MS);

    setStatus('pty-1', 'NOTHING_TO_SHOW');
    setStatus('pty-1', 'ALERT_RINGING');
    vi.advanceTimersByTime(DELAY_MS);

    expect(fired).toEqual(['pty-1', 'pty-1']);
  });

  it('is silent for a Session first seen already ringing (restore / reconnect)', () => {
    // `docs/specs/alert.md`: a ring must come from a fresh transition, never
    // from a remount or a restored snapshot. For push this is the difference
    // between "works" and "buzzes your phone every time you open your laptop".
    setStatus('restored', 'ALERT_RINGING');
    start();

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('is silent for a whole restored session blob, not just one pane', () => {
    // Standalone restores its session blob at launch, so several panes can
    // arrive already latched at once.
    for (const id of ['restored-1', 'restored-2', 'restored-3']) {
      setStatus(id, 'ALERT_RINGING');
    }
    start();

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });

  it('fires for each ringing Session independently', () => {
    start();
    ring('pty-1');
    vi.advanceTimersByTime(4_000);
    ring('pty-2');

    vi.advanceTimersByTime(DELAY_MS - 4_000);
    expect(fired).toEqual(['pty-1']);

    vi.advanceTimersByTime(4_000);
    expect(fired).toEqual(['pty-1', 'pty-2']);
  });

  it('fires for every pane that rings at the same moment', () => {
    start();
    ring('pty-1');
    ring('pty-2');
    ring('pty-3');

    vi.advanceTimersByTime(DELAY_MS);
    expect(fired.sort()).toEqual(['pty-1', 'pty-2', 'pty-3']);
  });

  it('reads the delay when the ring is scheduled', () => {
    delayMs = 2_000;
    start();
    ring('pty-1');

    vi.advanceTimersByTime(2_000);
    expect(fired).toEqual(['pty-1']);
  });

  it('cancels everything pending when disposed', () => {
    start();
    ring('pty-1');

    stop?.();
    stop = null;

    vi.advanceTimersByTime(60_000);
    expect(fired).toEqual([]);
  });
});

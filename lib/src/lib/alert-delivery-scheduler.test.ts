import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
import { createAlertDeliveryScheduler, type AlertDelivery, type AlertDeliveryScheduler } from './alert-delivery-scheduler';
import { DEFAULT_ALERT_SETTINGS, type AlertSettings } from './alert-settings-model';
import { engage, leave, REPORT } from './alert-manager-test-utils';

/**
 * When a ring is spoken or pushed (`docs/specs/alert.md` -> Alarm settings):
 * decided beside the manager, once per sink per episode, at the episode's start
 * plus the delay, and only if the user is not looking (speech) or not here at
 * all (push) when it comes due.
 */

const PANE = 'pane';
const OTHER = 'other';
const SPEAK_MS = 10_000;
const PUSH_MS = 20_000;

let manager: AlertManager;
let scheduler: AlertDeliveryScheduler;
let settings: AlertSettings;
let delivered: AlertDelivery[];

const sinks = () => delivered.map((delivery) => delivery.sink);
const ring = (id = PANE) => manager.notifyFromProtocol(id, REPORT);
/** Clear the ring with a click, then ring again on fresh output. */
const ringAgain = () => {
  manager.acknowledge(PANE, { input: false });
  manager.onData(PANE);
  ring();
};

beforeEach(() => {
  vi.useFakeTimers();
  manager = new AlertManager();
  settings = { ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: SPEAK_MS, pushEnabled: true, pushDelayMs: PUSH_MS };
  delivered = [];
  scheduler = createAlertDeliveryScheduler({
    manager,
    defaults: () => settings,
    deliver: (delivery) => void delivered.push(delivery),
  });
});

afterEach(() => {
  scheduler.dispose();
  manager.dispose();
  vi.useRealTimers();
});

describe('the delivery scheduler', () => {
  it('delivers each sink once per episode, its delay after the episode started', () => {
    ring();
    const episodeId = manager.getState(PANE).episode!.id;
    vi.advanceTimersByTime(SPEAK_MS - 1);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toEqual([{ sink: 'speech', id: PANE, episodeId }]);
    vi.advanceTimersByTime(PUSH_MS - SPEAK_MS);
    expect(delivered.at(-1)).toEqual({ sink: 'push', id: PANE, episodeId });

    // A second report joining the episode publishes its detail, and delivers
    // nothing more.
    manager.notifyFromProtocol(PANE, { source: 'OSC 9', title: null, body: 'deploy failed' });
    expect(manager.getState(PANE)).toMatchObject({ episode: { id: episodeId }, notification: { body: 'deploy failed' } });
    vi.advanceTimersByTime(10 * PUSH_MS);
    expect(sinks()).toEqual(['speech', 'push']);
  });

  it('never speaks at the pane the user is looking at, nor pushes to a user who is here', () => {
    ring();
    // Looking at it does not clear the ring; only a gesture acknowledges.
    engage(manager, PANE);
    vi.advanceTimersByTime(PUSH_MS);
    expect(manager.getState(PANE).status).toBe('ALERT_RINGING');
    expect(delivered).toEqual([]);

    // A deadline that failed is consumed, never retried.
    leave(manager);
    vi.advanceTimersByTime(10 * PUSH_MS);
    expect(delivered).toEqual([]);
  });

  it('speaks at a pane the user is not looking at, and pushes only once they are away', () => {
    ring();
    engage(manager, OTHER);
    vi.advanceTimersByTime(PUSH_MS);
    expect(sinks()).toEqual(['speech']);

    ringAgain();
    leave(manager);
    vi.advanceTimersByTime(PUSH_MS);
    expect(sinks()).toEqual(['speech', 'speech', 'push']);
  });

  it('cancels what a cleared ring had pending, and gives the next episode its own delay', () => {
    ring();
    vi.advanceTimersByTime(SPEAK_MS / 2);
    ringAgain();
    vi.advanceTimersByTime(SPEAK_MS - 1);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toEqual([{ sink: 'speech', id: PANE, episodeId: manager.getState(PANE).episode!.id }]);
  });

  it('consumes pending work when a sink turns off, and never replays it when it turns back on', () => {
    ring();
    vi.advanceTimersByTime(SPEAK_MS / 2);
    scheduler.publish('main', { [PANE]: { speakEnabled: false } });
    scheduler.publish('main', { [PANE]: { speakEnabled: true } });
    settings = { ...settings, pushEnabled: false };
    scheduler.recheck();
    settings = { ...settings, pushEnabled: true };
    vi.advanceTimersByTime(10 * PUSH_MS);
    expect(delivered).toEqual([]);
  });

  it('keeps a deadline through a later delay edit', () => {
    ring();
    vi.advanceTimersByTime(SPEAK_MS / 2);
    scheduler.publish('main', { [PANE]: { speakDelayMs: 60_000 } });
    vi.advanceTimersByTime(SPEAK_MS / 2);
    expect(sinks()).toEqual(['speech']);
  });

  it('never delivers an episode that began with its sink off', () => {
    settings = { ...settings, speakEnabled: false, pushEnabled: false };
    ring();
    settings = { ...settings, speakEnabled: true, pushEnabled: true };
    scheduler.recheck();
    vi.advanceTimersByTime(10 * PUSH_MS);
    expect(delivered).toEqual([]);
  });
});

describe('published policy', () => {
  it('resolves a Session\'s Workspace overrides over the defaults, delay included', () => {
    settings = { ...settings, speakEnabled: false, pushEnabled: false };
    scheduler.publish('main', { [PANE]: { speakEnabled: true, speakDelayMs: 2_000 }, [OTHER]: {} });
    ring();
    ring(OTHER);
    vi.advanceTimersByTime(2_000);
    expect(delivered).toEqual([{ sink: 'speech', id: PANE, episodeId: manager.getState(PANE).episode!.id }]);
  });

  it('keeps the last realm to publish a Session, whichever of the two publishes next', () => {
    scheduler.publish('source', { [PANE]: { speakEnabled: true } });
    scheduler.publish('target', { [PANE]: { speakEnabled: false } });
    // The source lets it go after the target took it: the target's stands.
    scheduler.publish('source', {});
    expect(scheduler.policy(PANE).speakEnabled).toBe(false);
    // A realm dropping a Session it last published returns it to the defaults.
    scheduler.publish('target', {});
    expect(scheduler.policy(PANE).speakEnabled).toBe(true);
  });

  it('keeps a live Session\'s overrides past its realm\'s end, and drops a gone one\'s', () => {
    ring();
    scheduler.publish('main', { [PANE]: { pushEnabled: false }, [OTHER]: { pushEnabled: false } });
    scheduler.endRealm('main');
    expect(scheduler.policy(PANE).pushEnabled).toBe(false);
    expect(scheduler.policy(OTHER).pushEnabled).toBe(true);
  });

  it('revalidates what a realm publishes', () => {
    scheduler.publish('main', { [PANE]: { speakEnabled: false } });
    scheduler.publish('main', null);
    scheduler.publish('main', [{ speakEnabled: true }]);
    expect(scheduler.policy(PANE).speakEnabled).toBe(false);
    scheduler.publish('main', { [PANE]: { speakEnabled: 'no', speakDelayMs: Number.NaN, pushDelayMs: -5 } });
    expect(scheduler.policy(PANE)).toMatchObject({ speakEnabled: true, speakDelayMs: SPEAK_MS, pushDelayMs: 1_000 });
  });
});

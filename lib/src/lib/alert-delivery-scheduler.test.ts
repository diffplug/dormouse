import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AlertManager } from './alert-manager';
import { createAlertDeliveryScheduler, type AlertDeliveryScheduler } from './alert-delivery-scheduler';
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
const SETTINGS: AlertSettings = { ...DEFAULT_ALERT_SETTINGS, speakEnabled: true, speakDelayMs: SPEAK_MS, pushEnabled: true, pushDelayMs: PUSH_MS };

type Delivered = { sink: 'speech'; id: string; episodeId: string } | { sink: 'push'; id: string; title: string };

let manager: AlertManager;
let scheduler: AlertDeliveryScheduler;
let delivered: Delivered[];

const sinks = () => delivered.map((delivery) => delivery.sink);
const episodeId = (id = PANE) => manager.getState(id).episode!.id;
const ring = (id = PANE) => manager.notifyFromProtocol(id, REPORT);
/** Clear the ring with a click, then ring again on fresh output. */
const ringAgain = () => {
  manager.acknowledge(PANE, { input: false });
  manager.onData(PANE);
  ring();
};
const session = (overrides: object, label = 'pnpm build') => ({ label, overrides });

beforeEach(() => {
  vi.useFakeTimers();
  manager = new AlertManager();
  delivered = [];
  scheduler = createAlertDeliveryScheduler({
    manager,
    speak: (id, episode) => void delivered.push({ sink: 'speech', id, episodeId: episode }),
    push: (id, title) => void delivered.push({ sink: 'push', id, title }),
  });
  scheduler.setDefaults(SETTINGS);
});

afterEach(() => {
  scheduler.dispose();
  manager.dispose();
  vi.useRealTimers();
});

describe('the delivery scheduler', () => {
  it('delivers each sink once per episode, its delay after the episode started', () => {
    ring();
    const episode = episodeId();
    vi.advanceTimersByTime(SPEAK_MS - 1);
    expect(delivered).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(delivered).toEqual([{ sink: 'speech', id: PANE, episodeId: episode }]);
    vi.advanceTimersByTime(PUSH_MS - SPEAK_MS);
    // Unpublished, the Session is called what its label falls back to.
    expect(delivered.at(-1)).toEqual({ sink: 'push', id: PANE, title: 'terminal' });

    // A second report joining the episode publishes its detail, and delivers
    // nothing more.
    manager.notifyFromProtocol(PANE, { source: 'OSC 9', title: null, body: 'deploy failed' });
    expect(manager.getState(PANE)).toMatchObject({ episode: { id: episode }, notification: { body: 'deploy failed' } });
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
    expect(delivered).toEqual([{ sink: 'speech', id: PANE, episodeId: episodeId() }]);
  });

  it('consumes pending work when a sink turns off, and never replays it when it turns back on', () => {
    ring();
    vi.advanceTimersByTime(SPEAK_MS / 2);
    scheduler.publish('main', { [PANE]: session({ speakEnabled: false }) });
    scheduler.publish('main', { [PANE]: session({ speakEnabled: true }) });
    scheduler.setDefaults({ ...SETTINGS, pushEnabled: false });
    scheduler.setDefaults(SETTINGS);
    vi.advanceTimersByTime(10 * PUSH_MS);
    expect(delivered).toEqual([]);
  });

  it('keeps a deadline through a later delay edit', () => {
    ring();
    vi.advanceTimersByTime(SPEAK_MS / 2);
    scheduler.publish('main', { [PANE]: session({ speakDelayMs: 60_000 }) });
    vi.advanceTimersByTime(SPEAK_MS / 2);
    expect(sinks()).toEqual(['speech']);
  });

  it('never delivers an episode that began with its sink off', () => {
    scheduler.setDefaults({ ...SETTINGS, speakEnabled: false, pushEnabled: false });
    ring();
    scheduler.setDefaults(SETTINGS);
    vi.advanceTimersByTime(10 * PUSH_MS);
    expect(delivered).toEqual([]);
  });
});

describe('published Sessions', () => {
  it('resolves a Session\'s Workspace overrides over the defaults, delay included, and titles its push', () => {
    scheduler.setDefaults({ ...SETTINGS, speakEnabled: false, pushEnabled: false });
    scheduler.publish('main', { [PANE]: session({ pushEnabled: true, pushDelayMs: 2_000 }), [OTHER]: session({}) });
    ring();
    ring(OTHER);
    vi.advanceTimersByTime(2_000);
    expect(delivered).toEqual([{ sink: 'push', id: PANE, title: 'pnpm build' }]);
  });

  it('keeps the last realm to publish a Session, whichever of the two publishes next', () => {
    scheduler.setDefaults({ ...SETTINGS, pushEnabled: false });
    scheduler.publish('source', { [PANE]: session({ speakEnabled: false }) });
    scheduler.publish('target', { [PANE]: session({}) });
    // The source lets it go after the target took it: the target's stands.
    scheduler.publish('source', {});
    ring();
    vi.advanceTimersByTime(SPEAK_MS);
    expect(sinks()).toEqual(['speech']);
  });

  it('keeps a Session a partial publication omits, and the alarm its override armed', () => {
    scheduler.setDefaults({ ...SETTINGS, speakEnabled: false, pushEnabled: false });
    scheduler.publish('main', { [PANE]: session({ speakEnabled: true }), [OTHER]: session({}) });
    ring();
    // A reload publishes its first Wall before the one showing the ring.
    scheduler.publish('main', { [OTHER]: session({}) });
    scheduler.publish('main', { [PANE]: session({ speakEnabled: true }), [OTHER]: session({}) });
    vi.advanceTimersByTime(SPEAK_MS);
    expect(delivered).toEqual([{ sink: 'speech', id: PANE, episodeId: episodeId() }]);
  });

  it('gives a Session that moved its new owner\'s overrides', () => {
    scheduler.setDefaults({ ...SETTINGS, pushEnabled: false });
    scheduler.publish('source', { [PANE]: session({}) });
    ring();
    scheduler.publish('target', { [PANE]: session({ speakEnabled: false }) });
    scheduler.publish('source', {});
    vi.advanceTimersByTime(SPEAK_MS);
    expect(delivered).toEqual([]);
  });

  it('forgets an omitted Session only while it has no alert state', () => {
    scheduler.setDefaults({ ...SETTINGS, pushEnabled: false });
    scheduler.publish('main', { [PANE]: session({ speakEnabled: false }), [OTHER]: session({ speakEnabled: false }) });
    ring();
    scheduler.publish('main', {});
    // OTHER had none, so nothing was pending on it: it is back on the defaults.
    ring(OTHER);
    ringAgain();
    vi.advanceTimersByTime(SPEAK_MS);
    expect(delivered).toEqual([{ sink: 'speech', id: OTHER, episodeId: episodeId(OTHER) }]);
  });

  it.each([
    ['ringing', () => ring(OTHER)],
    // Nothing to publish on its way out: its last state was the default.
    ['answered', () => { ring(OTHER); manager.acknowledge(OTHER, { input: true }); }],
  ] as const)('keeps a live Session\'s publication past its realm, and forgets one removed %s', (_state, before) => {
    scheduler.publish('main', { [PANE]: session({ pushEnabled: false }), [OTHER]: session({ pushEnabled: false }) });
    before();
    manager.remove(OTHER);
    // The realm is gone, and never published again; a Session reusing the id
    // is not the one it described.
    ring();
    ring(OTHER);
    vi.advanceTimersByTime(PUSH_MS);
    expect(delivered.filter((delivery) => delivery.sink === 'push')).toEqual([{ sink: 'push', id: OTHER, title: 'terminal' }]);
  });

  it('keeps a Session\'s publication through a respawn under its id', () => {
    // The realm sends a Session again only once its label or overrides change.
    scheduler.publish('main', { [PANE]: session({ speakEnabled: false }, 'claude') });
    ring();
    manager.restart(PANE);
    ring();
    vi.advanceTimersByTime(PUSH_MS);
    expect(delivered).toEqual([{ sink: 'push', id: PANE, title: 'claude' }]);
  });

  it('revalidates what a realm publishes', () => {
    scheduler.publish('main', { [PANE]: session({ speakEnabled: false }) });
    scheduler.publish('main', null);
    scheduler.publish('main', [session({ speakEnabled: true })]);
    ring();
    vi.advanceTimersByTime(SPEAK_MS);
    expect(delivered).toEqual([]);

    scheduler.publish('main', {
      [PANE]: { label: 42, overrides: { speakEnabled: 'no', speakDelayMs: Number.NaN, pushDelayMs: -5 } },
    });
    ringAgain();
    vi.advanceTimersByTime(SPEAK_MS);
    // The push delay clamps to its floor; the rest fall back to the defaults.
    expect(delivered).toEqual([
      { sink: 'push', id: PANE, title: 'terminal' },
      { sink: 'speech', id: PANE, episodeId: episodeId() },
    ]);
  });
});

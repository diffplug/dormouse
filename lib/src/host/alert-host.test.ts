import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAlertHost, type AlertHost, type AlertRealm } from './alert-host';
import type { AlertAwaitResult, AlertSpeak } from './alert-protocol';
import { DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings-model';
import { REPORT } from '../lib/alert-manager-test-utils';

/**
 * The alerts' host role, as both hosts run it (`docs/specs/alert.md`). Every
 * renderer realm is a viewer of the one manager: what matters is that one
 * realm's end never touches another's, that every await is answered exactly
 * once and only to the realm that parked it, and that nothing a renderer sends
 * is installed unchecked.
 */

let host: AlertHost;
/** Every await outcome, by the realm it was answered to. */
let answers: Array<{ realm: string } & AlertAwaitResult>;
/** Each realm's `sync` answer: the Session ids re-sent, and the store snapshots. */
let resent: Array<{ realm: string; ids?: readonly string[]; names?: string[]; settings?: unknown }>;
let watched: string[][];
let settings: Array<Record<string, unknown>>;
let spoken: AlertSpeak[];
let pushed: Array<[string, string]>;

function realmFor(name: string): AlertRealm {
  return {
    answer: (result) => void answers.push({ realm: name, ...result }),
    resendStates: (ids) => void resent.push({ realm: name, ids }),
    resendWatchedCommands: (names) => void resent.push({ realm: name, names }),
    resendSettings: (value) => void resent.push({ realm: name, settings: value }),
  };
}

/** One command from realm `name`. */
const from = (name: string, command: unknown) => host.handle(name, command, realmFor(name));

beforeEach(() => {
  spoken = [];
  pushed = [];
  host = createAlertHost({ push: (sessionId, title) => void pushed.push([sessionId, title]) });
  host.onSpeak((speak) => void spoken.push(speak));
  answers = [];
  resent = [];
  watched = [];
  settings = [];
  host.watched.subscribe((names) => void watched.push(names));
  host.settings.subscribe((value) => void settings.push(value as unknown as Record<string, unknown>));
});

afterEach(() => {
  host.dispose();
  vi.useRealTimers();
});

describe('the WATCHING rule set', () => {
  it('takes the first realm\'s seed, corrects every later one, and watches with it', () => {
    from('main', { op: 'initializeWatchedCommands', names: ['npm test'] });
    expect(watched.at(-1)).toEqual(['npm test']);

    // A second realm offering its own persisted copy is answered with the
    // canonical set, not allowed to replace it.
    from('ws-2', { op: 'initializeWatchedCommands', names: ['cargo build'] });
    expect(watched.at(-1)).toEqual(['npm test']);
    expect(host.manager.getWatchedCommands()).toEqual(['npm test']);
  });

  it('applies an edit as a delta, so a stale realm cannot drop other rules', () => {
    from('main', { op: 'initializeWatchedCommands', names: ['npm test'] });
    from('ws-2', { op: 'setCommandWatched', name: ' cargo build ', watched: true });
    expect(watched.at(-1)).toEqual(['cargo build', 'npm test']);

    from('main', { op: 'setCommandWatched', name: 'npm test', watched: false });
    expect(watched.at(-1)).toEqual(['cargo build']);
  });

  it('ignores a malformed edit rather than installing it', () => {
    from('main', { op: 'initializeWatchedCommands', names: ['npm test', 42, null, ''] });
    expect(watched.at(-1)).toEqual(['npm test']);
    const before = watched.length;
    from('main', { op: 'setCommandWatched', name: 7, watched: 'yes' });
    from('main', { op: 'setCommandWatched', name: '  ', watched: true });
    from('main', { op: 'nonsense' });
    from('main', null);
    expect(watched).toHaveLength(before);
  });
});

describe('the alarm settings', () => {
  it('takes the first seed and corrects every later one, and any realm\'s edit', () => {
    from('main', { op: 'initializeSettings', settings: { ...DEFAULT_ALERT_SETTINGS, speakEnabled: true } });
    from('ws-2', { op: 'initializeSettings', settings: { ...DEFAULT_ALERT_SETTINGS, speakEnabled: false } });
    expect(settings.at(-1)).toMatchObject({ speakEnabled: true });

    from('ws-2', { op: 'updateSettings', settings: { ...DEFAULT_ALERT_SETTINGS, pushEnabled: true } });
    expect(settings.at(-1)).toMatchObject({ pushEnabled: true });
  });

  it('revalidates whatever a renderer sends', () => {
    // A NaN or an absurd timer must never reach a host because a renderer asked.
    from('main', { op: 'initializeSettings', settings: { speakDelayMs: Number.NaN, pushDelayMs: 1e12 } });
    const installed = settings.at(-1)!;
    expect(installed.speakDelayMs).toBe(DEFAULT_ALERT_SETTINGS.speakDelayMs);
    expect(installed.pushDelayMs).toBeLessThanOrEqual(600_000);
  });
});

it('carries each verb a realm sends to the one manager', () => {
  host.manager.notifyFromProtocol('pty-1', REPORT);
  from('main', { op: 'dismiss', id: 'pty-1' });
  expect(host.manager.getState('pty-1')).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });
  from('main', { op: 'clearTodo', id: 'pty-1' });
  expect(host.manager.getState('pty-1').todo).toBe(false);
  from('main', { op: 'toggleTodo', id: 'pty-1' });
  expect(host.manager.getState('pty-1').todo).toBe(true);

  host.manager.notifyFromProtocol('pty-2', REPORT);
  from('main', { op: 'acknowledge', id: 'pty-2' });
  expect(host.manager.getState('pty-2')).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });

  // Nothing to act on without a Session.
  from('main', { op: 'toggleTodo', id: '' });
  expect(host.manager.getAllStates().has('')).toBe(false);
});

it('starts a respawned Session over, from the persisted state it was spawned with', () => {
  host.manager.notifyFromProtocol('pty-1', REPORT);
  host.respawn('pty-1', { status: 'ALERT_RINGING', todo: true, notification: REPORT });
  // A seed restores the reminder, never the ring.
  expect(host.manager.getState('pty-1')).toMatchObject({ status: 'WATCHING_DISABLED', todo: true, notification: REPORT });

  host.manager.notifyFromProtocol('pty-2', REPORT);
  host.respawn('pty-2');
  expect(host.manager.getState('pty-2')).toMatchObject({ status: 'WATCHING_DISABLED', todo: false });
  // No tombstone: the new generation's output is its own Session's.
  host.manager.onData('pty-2');
  expect(host.manager.has('pty-2')).toBe(true);
});

it('re-sends the asking realm its own Sessions and both stores on sync, to it alone, ending nothing', () => {
  from('main', { op: 'initializeWatchedCommands', names: ['npm test'] });
  from('main', { op: 'initializeSettings', settings: DEFAULT_ALERT_SETTINGS });
  from('main', { op: 'engagement', state: { present: true, focusId: 'pty-a' } });
  watched = [];
  settings = [];

  from('main', { op: 'sync', ids: ['pty-a', 42, ''] });
  expect(resent).toEqual([
    { realm: 'main', ids: ['pty-a'] },
    { realm: 'main', names: ['npm test'] },
    { realm: 'main', settings: DEFAULT_ALERT_SETTINGS },
  ]);
  // No broadcast: every other realm's copies are intact.
  expect(watched).toEqual([]);
  expect(settings).toEqual([]);
  expect(host.manager.viewerIds()).toEqual(['main']);

  resent = [];
  from('main', { op: 'sync' });
  expect(resent[0]).toEqual({ realm: 'main', ids: [] });
});

it('never snapshots a store no realm has seeded', () => {
  // It would replace the renderers' persisted copies with the defaults.
  from('main', { op: 'sync', ids: [] });
  expect(resent).toEqual([{ realm: 'main', ids: [] }]);
});

describe('realms', () => {
  const engaged = (name: string, focusId: string | null) =>
    from(name, { op: 'engagement', state: { present: true, focusId } });

  it('keeps engagement per realm, so one leaving never disengages another', () => {
    engaged('main', 'pty-a');
    engaged('ws-2', 'pty-b');
    from('main', { op: 'engagement', state: { present: false, focusId: null }, lapse: 'leave' });

    host.manager.notifyFromProtocol('pty-b', REPORT);
    expect(host.manager.getState('pty-b').status).not.toBe('ALERT_RINGING');
    host.manager.notifyFromProtocol('pty-a', REPORT);
    expect(host.manager.getState('pty-a').status).toBe('ALERT_RINGING');
  });

  it('ends a realm on hello, answering what it parked, and no other realm\'s', () => {
    engaged('main', 'pty-a');
    engaged('ws-2', 'pty-b');
    from('main', { op: 'await', awaitId: 'await-main', id: 'pty-c', until: 'exit', timeoutMs: 600_000 });
    from('ws-2', { op: 'await', awaitId: 'await-ws2', id: 'pty-c', until: 'exit', timeoutMs: 600_000 });

    from('main', { op: 'hello' });
    // Synchronously: a disposing webview stops listening right after.
    expect(answers).toEqual([{ realm: 'main', awaitId: 'await-main', outcome: expect.objectContaining({ kind: 'cancelled' }) }]);
    host.manager.notifyFromProtocol('pty-a', REPORT);
    expect(host.manager.getState('pty-a').status).toBe('ALERT_RINGING');
    host.manager.notifyFromProtocol('pty-b', REPORT);
    expect(host.manager.getState('pty-b').status).not.toBe('ALERT_RINGING');
    expect(host.manager.getState('pty-c').awaited).toBe(true);
  });

  it('answers once when the manager settles an await its realm\'s end already answered', async () => {
    from('main', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'quiet', timeoutMs: 600_000 });
    host.endRealm('main');
    await Promise.resolve();
    await Promise.resolve();
    expect(answers).toHaveLength(1);
  });

  it('keeps answering while a torn-down realm refuses its answer', () => {
    host.handle('main', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'exit', timeoutMs: 600_000 }, {
      answer: () => { throw new Error('webview disposed'); },
      resendStates: () => {},
      resendWatchedCommands: () => {},
      resendSettings: () => {},
    });
    from('main', { op: 'await', awaitId: 'await-2', id: 'pty-2', until: 'exit', timeoutMs: 600_000 });
    host.endRealm('main');
    expect(answers.map((answer) => answer.awaitId)).toEqual(['await-2']);
    expect(host.manager.getState('pty-1').awaited).toBe(false);
  });

  it('ends every realm that is no longer live, and keeps the ones that are', () => {
    engaged('main', 'pty-a');
    engaged('ws-2', 'pty-b');
    // A realm known only by what it parked.
    from('ws-3', { op: 'await', awaitId: 'await-ws3', id: 'pty-c', until: 'quiet', timeoutMs: 600_000 });

    host.retainRealms(['main']);
    expect(answers).toEqual([{ realm: 'ws-3', awaitId: 'await-ws3', outcome: expect.objectContaining({ kind: 'cancelled' }) }]);
    expect(host.manager.viewerIds()).toEqual(['main']);
    host.manager.notifyFromProtocol('pty-b', REPORT);
    expect(host.manager.getState('pty-b').status).toBe('ALERT_RINGING');
  });
});

/**
 * The scheduler runs in the host so that no realm's end can lose or repeat a
 * delivery (`docs/specs/alert.md` -> Alarm settings); what it resolves is
 * `alert-delivery-scheduler.test.ts`.
 */
describe('delivery', () => {
  const OFF = { ...DEFAULT_ALERT_SETTINGS, speakEnabled: false, speakDelayMs: 5_000, pushEnabled: false, pushDelayMs: 5_000 };
  const SPEAK_AND_PUSH = { 'pty-1': { label: 'pnpm build', overrides: { speakEnabled: true, pushEnabled: true } } };

  beforeEach(() => {
    vi.useFakeTimers();
    from('main', { op: 'initializeSettings', settings: OFF });
  });

  it('takes a realm\'s published Sessions, speaks to its listeners, and pushes through its capability', () => {
    from('main', { op: 'sessions', sessions: SPEAK_AND_PUSH });
    host.manager.notifyFromProtocol('pty-1', REPORT);
    vi.advanceTimersByTime(5_000);
    expect(spoken).toEqual([{ id: 'pty-1', episodeId: host.manager.getState('pty-1').episode!.id }]);
    expect(pushed).toEqual([['pty-1', 'pnpm build']]);
  });

  it('delivers once across its realm\'s reload, whose publication outlives the gap', () => {
    from('main', { op: 'sessions', sessions: SPEAK_AND_PUSH });
    host.manager.notifyFromProtocol('pty-1', REPORT);
    vi.advanceTimersByTime(4_000);
    // The reload: the old realm ends, and the new one publishes after the deadline.
    from('main', { op: 'hello' });
    vi.advanceTimersByTime(2_000);
    from('main', { op: 'sessions', sessions: SPEAK_AND_PUSH });
    vi.advanceTimersByTime(60_000);
    expect(spoken).toHaveLength(1);
    expect(pushed).toHaveLength(1);
  });

  it('rechecks pending work when the settings change', () => {
    from('main', { op: 'updateSettings', settings: { ...OFF, speakEnabled: true } });
    host.manager.notifyFromProtocol('pty-1', REPORT);
    from('main', { op: 'updateSettings', settings: OFF });
    from('main', { op: 'updateSettings', settings: { ...OFF, speakEnabled: true } });
    vi.advanceTimersByTime(60_000);
    expect(spoken).toEqual([]);
  });

  it('leaves nothing pending once disposed', () => {
    from('main', { op: 'updateSettings', settings: { ...OFF, speakEnabled: true } });
    host.manager.notifyFromProtocol('pty-1', REPORT);
    host.dispose();
    expect(vi.getTimerCount()).toBe(0);
    host = createAlertHost({ push: () => {} });
  });
});

describe('awaits', () => {
  it('answers each await once, to the realm that parked it', async () => {
    from('ws-2', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'quiet', timeoutMs: 600_000 });
    expect(host.manager.getState('pty-1').awaited).toBe(true);

    host.manager.notifyFromProtocol('pty-1', REPORT);
    await Promise.resolve();
    expect(answers).toEqual([
      { realm: 'ws-2', awaitId: 'await-1', outcome: expect.objectContaining({ kind: 'resolved', cause: 'bell' }) },
    ]);
    // Claimed: the bell reached the program, not the human.
    expect(host.manager.getState('pty-1').status).not.toBe('ALERT_RINGING');
  });

  it('answers a cancel once, with the host outcome, and only the parking realm may cancel', async () => {
    from('main', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'exit', timeoutMs: 600_000 });
    from('ws-2', { op: 'awaitCancel', awaitId: 'await-1' });
    await Promise.resolve();
    expect(answers).toEqual([]);

    from('main', { op: 'awaitCancel', awaitId: 'await-1' });
    await Promise.resolve();
    from('main', { op: 'awaitCancel', awaitId: 'await-1' });
    await Promise.resolve();
    expect(answers).toEqual([{ realm: 'main', awaitId: 'await-1', outcome: expect.objectContaining({ kind: 'cancelled' }) }]);
    expect(host.manager.getState('pty-1').awaited).toBe(false);
  });

  it('refuses a malformed await with an answer rather than parking it', async () => {
    from('main', { op: 'await', awaitId: 'await-bad', id: 'pty-1', until: 'soon', timeoutMs: 600_000 });
    from('main', { op: 'await', awaitId: 'await-nan', id: 'pty-1', until: 'exit', timeoutMs: 'forever' });
    from('main', { op: 'await', awaitId: 'await-noid', until: 'exit', timeoutMs: 600_000 });
    // Nothing to answer to.
    from('main', { op: 'await', id: 'pty-1', until: 'exit', timeoutMs: 600_000 });
    await Promise.resolve();
    expect(answers.map((answer) => [answer.awaitId, answer.outcome.kind])).toEqual([
      ['await-bad', 'cancelled'],
      ['await-noid', 'cancelled'],
      ['await-nan', 'cancelled'],
    ]);
    expect(host.manager.getState('pty-1').awaited).toBe(false);
  });

  it('refuses a repeated id, which would owe one caller two answers', async () => {
    from('main', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'exit', timeoutMs: 600_000 });
    from('main', { op: 'await', awaitId: 'await-1', id: 'pty-2', until: 'exit', timeoutMs: 600_000 });
    expect(host.manager.getState('pty-2').awaited).toBe(false);
    // Another realm's ids are its own.
    from('ws-2', { op: 'await', awaitId: 'await-1', id: 'pty-2', until: 'exit', timeoutMs: 600_000 });
    expect(host.manager.getState('pty-2').awaited).toBe(true);
  });
});

it('answers nothing once disposed', async () => {
  from('main', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'exit', timeoutMs: 600_000 });
  host.dispose();
  await Promise.resolve();
  expect(answers).toEqual([]);
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSidecarAlerts, type SidecarAlerts } from './alert-host';
import type { AlertAwaitResult } from './alert-protocol';
import { DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings-model';
import type { AlertState } from '../lib/alert-manager';

/**
 * Standalone's one `AlertManager`, in the sidecar (`docs/specs/standalone.md` →
 * "Alerts"). Every window is a viewer of it by its label, which Rust stamps on
 * each command as `window`; what matters is that one window's realm ending
 * never touches another's, that every await is answered exactly once, and
 * that a window collecting its PTYs gets their state back.
 */

let sent: Array<{ event: string; data: unknown }>;
let alerts: SidecarAlerts;

const REPORT = { source: 'OSC 9', title: null, body: 'needs input' } as const;

const watched = (): string[][] =>
  sent.filter((message) => message.event === 'alert:watchedCommands')
    .map((message) => (message.data as { names: string[] }).names);
const settings = () =>
  sent.filter((message) => message.event === 'alert:settings')
    .map((message) => (message.data as { settings: Record<string, unknown> }).settings);
const states = (id: string) =>
  sent.filter((message) => message.event === 'alert:state' && (message.data as { id: string }).id === id)
    .map((message) => message.data as { id: string } & AlertState);
const results = () =>
  sent.filter((message) => message.event === 'alert:awaitResult').map((message) => message.data as AlertAwaitResult);

/** One command as Rust forwards it: stamped with the window that sent it. */
const from = (window: string, command: Record<string, unknown>) => alerts.handle({ ...command, window });

beforeEach(() => {
  sent = [];
  alerts = createSidecarAlerts({ send: (event, data) => sent.push({ event, data }) });
});

afterEach(() => {
  alerts.dispose();
  vi.useRealTimers();
});

describe('the WATCHING rule set', () => {
  it('takes the first window\'s seed, corrects every later one, and watches with it', () => {
    from('main', { op: 'initializeWatchedCommands', names: ['npm test'] });
    expect(watched().at(-1)).toEqual(['npm test']);

    // A second window offering its own persisted copy is answered with the
    // canonical set, not allowed to replace it.
    from('ws-2', { op: 'initializeWatchedCommands', names: ['cargo build'] });
    expect(watched().at(-1)).toEqual(['npm test']);
    expect(alerts.manager.getWatchedCommands()).toEqual(['npm test']);
  });

  it('applies an edit as a delta, so a stale window cannot drop other rules', () => {
    from('main', { op: 'initializeWatchedCommands', names: ['npm test'] });
    from('ws-2', { op: 'setCommandWatched', name: 'cargo build', watched: true });
    expect(watched().at(-1)).toEqual(['cargo build', 'npm test']);

    from('main', { op: 'setCommandWatched', name: 'npm test', watched: false });
    expect(watched().at(-1)).toEqual(['cargo build']);
  });

  it('ignores a malformed edit rather than installing it', () => {
    from('main', { op: 'initializeWatchedCommands', names: ['npm test', 42, null, ''] });
    expect(watched().at(-1)).toEqual(['npm test']);
    const before = sent.length;
    from('main', { op: 'setCommandWatched', name: 7, watched: 'yes' });
    from('main', { op: 'nonsense' });
    alerts.handle(null);
    expect(sent).toHaveLength(before);
  });
});

describe('the alarm settings', () => {
  it('takes the first seed and corrects every later one', () => {
    from('main', { op: 'initializeSettings', settings: { ...DEFAULT_ALERT_SETTINGS, speakEnabled: true } });
    expect(settings().at(-1)).toMatchObject({ speakEnabled: true });

    from('ws-2', { op: 'initializeSettings', settings: { ...DEFAULT_ALERT_SETTINGS, speakEnabled: false } });
    expect(settings().at(-1)).toMatchObject({ speakEnabled: true });
  });

  it('takes an explicit edit from any window', () => {
    from('main', { op: 'initializeSettings', settings: DEFAULT_ALERT_SETTINGS });
    from('ws-2', { op: 'updateSettings', settings: { ...DEFAULT_ALERT_SETTINGS, pushEnabled: true } });
    expect(settings().at(-1)).toMatchObject({ pushEnabled: true });
  });

  it('revalidates whatever a renderer sends', () => {
    // A NaN or an absurd timer must never reach a host because a webview asked.
    from('main', { op: 'initializeSettings', settings: { speakDelayMs: Number.NaN, pushDelayMs: 1e12 } });
    const installed = settings().at(-1)!;
    expect(installed.speakDelayMs).toBe(DEFAULT_ALERT_SETTINGS.speakDelayMs);
    expect(installed.pushDelayMs).toBeLessThanOrEqual(600_000);
  });
});

describe('Session state', () => {
  it('publishes every change as alert:state, for the host to route by owner', () => {
    alerts.manager.notifyFromProtocol('pty-1', REPORT);
    expect(states('pty-1').at(-1)).toMatchObject({ id: 'pty-1', status: 'ALERT_RINGING', todo: true });
  });

  it('carries each verb a window sends to the one manager', () => {
    alerts.manager.notifyFromProtocol('pty-1', REPORT);
    from('main', { op: 'dismiss', id: 'pty-1' });
    expect(states('pty-1').at(-1)).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });
    from('main', { op: 'clearTodo', id: 'pty-1' });
    expect(states('pty-1').at(-1)).toMatchObject({ todo: false });
    from('main', { op: 'toggleTodo', id: 'pty-1' });
    expect(states('pty-1').at(-1)).toMatchObject({ todo: true });

    alerts.manager.notifyFromProtocol('pty-2', REPORT);
    from('main', { op: 'acknowledge', id: 'pty-2' });
    expect(states('pty-2').at(-1)).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });

    from('main', { op: 'seed', id: 'pty-3', state: { status: 'ALERT_RINGING', todo: true, notification: REPORT } });
    // A seed restores the reminder, never the ring.
    expect(states('pty-3').at(-1)).toMatchObject({ status: 'WATCHING_DISABLED', todo: true, notification: REPORT });

    from('main', { op: 'remove', id: 'pty-3' });
    expect(states('pty-3').at(-1)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false });
    expect(alerts.manager.getAllStates().has('pty-3')).toBe(false);
  });

  it('acknowledges human input with its echo window before the write it rides', () => {
    alerts.manager.notifyFromProtocol('pty-1', REPORT);
    alerts.acknowledgeInput('pty-1');
    expect(states('pty-1').at(-1)).toMatchObject({ status: 'WATCHING_DISABLED', todo: false });
    // A bell answering the key rings no one.
    alerts.manager.notifyFromProtocol('pty-1', REPORT);
    expect(states('pty-1').at(-1)?.status).not.toBe('ALERT_RINGING');
  });

  it('mirrors a helper, which publishes nothing until promotion', () => {
    alerts.setHelper('pty-h', true);
    alerts.manager.notifyFromProtocol('pty-h', REPORT);
    expect(states('pty-h')).toEqual([]);
  });

  // What `pty:requestInit` sends behind its list: a window that reloaded or is
  // taking a Workspace over has no other way to learn its Sessions' state.
  it('re-sends the listed Sessions\' state, and every Session\'s when none are listed', () => {
    alerts.manager.notifyFromProtocol('pty-1', REPORT);
    from('main', { op: 'toggleTodo', id: 'pty-2' });
    alerts.setHelper('pty-h', true);
    alerts.manager.onData('pty-h');
    sent = [];

    alerts.publish(['pty-1', 'never-seen']);
    expect(sent).toEqual([
      { event: 'alert:state', data: expect.objectContaining({ id: 'pty-1', status: 'ALERT_RINGING', todo: true }) },
    ]);

    sent = [];
    alerts.publish(undefined);
    expect(sent.map((message) => (message.data as { id: string }).id).sort()).toEqual(['pty-1', 'pty-2']);
  });
});

describe('viewers', () => {
  const engaged = (window: string, focusId: string | null) =>
    from(window, { op: 'engagement', state: { present: true, focusId } });

  it('keeps engagement per window label, so one window leaving never disengages another', () => {
    engaged('main', 'pty-a');
    engaged('ws-2', 'pty-b');
    from('main', { op: 'engagement', state: { present: false, focusId: null }, lapse: 'leave' });

    alerts.manager.notifyFromProtocol('pty-b', REPORT);
    expect(alerts.manager.getState('pty-b').status).not.toBe('ALERT_RINGING');
    alerts.manager.notifyFromProtocol('pty-a', REPORT);
    expect(alerts.manager.getState('pty-a').status).toBe('ALERT_RINGING');
  });

  it('ends a window\'s previous realm on hello, and no other window\'s', () => {
    engaged('main', 'pty-a');
    engaged('ws-2', 'pty-b');
    from('main', { op: 'await', awaitId: 'await-main', id: 'pty-c', until: 'exit', timeoutMs: 600_000 });
    from('ws-2', { op: 'await', awaitId: 'await-ws2', id: 'pty-c', until: 'exit', timeoutMs: 600_000 });

    // `main` reloaded: same label, new realm.
    from('main', { op: 'hello' });
    expect(results()).toEqual([{ awaitId: 'await-main', window: 'main', outcome: expect.objectContaining({ kind: 'cancelled' }) }]);
    alerts.manager.notifyFromProtocol('pty-a', REPORT);
    expect(alerts.manager.getState('pty-a').status).toBe('ALERT_RINGING');
    alerts.manager.notifyFromProtocol('pty-b', REPORT);
    expect(alerts.manager.getState('pty-b').status).not.toBe('ALERT_RINGING');
    expect(alerts.manager.getState('pty-c').awaited).toBe(true);
  });

  it('drops a window that went away, and keeps the ones still open', () => {
    engaged('main', 'pty-a');
    engaged('ws-2', 'pty-b');
    from('ws-2', { op: 'await', awaitId: 'await-ws2', id: 'pty-c', until: 'quiet', timeoutMs: 600_000 });

    alerts.setWindows(['main']);
    expect(results()).toEqual([{ awaitId: 'await-ws2', window: 'ws-2', outcome: expect.objectContaining({ kind: 'cancelled' }) }]);
    alerts.manager.notifyFromProtocol('pty-b', REPORT);
    expect(alerts.manager.getState('pty-b').status).toBe('ALERT_RINGING');
    alerts.manager.notifyFromProtocol('pty-a', REPORT);
    expect(alerts.manager.getState('pty-a').status).not.toBe('ALERT_RINGING');

    // Not a label list: nothing to act on.
    alerts.setWindows(undefined);
    alerts.manager.notifyFromProtocol('pty-a', REPORT);
    expect(alerts.manager.getState('pty-a').status).not.toBe('ALERT_RINGING');
  });
});

describe('awaits', () => {
  it('answers each await once, broadcast-shaped: no Session id, no requestId', async () => {
    from('ws-2', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'quiet', timeoutMs: 600_000 });
    expect(alerts.manager.getState('pty-1').awaited).toBe(true);

    alerts.manager.notifyFromProtocol('pty-1', REPORT);
    await Promise.resolve();
    expect(results()).toEqual([
      { awaitId: 'await-1', window: 'ws-2', outcome: expect.objectContaining({ kind: 'resolved', cause: 'bell' }) },
    ]);
    const [message] = sent.filter((line) => line.event === 'alert:awaitResult');
    expect(Object.keys(message!.data as object).sort()).toEqual(['awaitId', 'outcome', 'window']);
    // Claimed: the bell reached the program, not the human.
    expect(alerts.manager.getState('pty-1').status).not.toBe('ALERT_RINGING');
  });

  it('answers a cancel once, with the host outcome', async () => {
    from('main', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'exit', timeoutMs: 600_000 });
    from('main', { op: 'awaitCancel', awaitId: 'await-1' });
    await Promise.resolve();
    from('main', { op: 'awaitCancel', awaitId: 'await-1' });
    await Promise.resolve();
    expect(results()).toEqual([{ awaitId: 'await-1', window: 'main', outcome: expect.objectContaining({ kind: 'cancelled' }) }]);
    expect(alerts.manager.getState('pty-1').awaited).toBe(false);
  });

  it('refuses a malformed await with an answer rather than parking it', async () => {
    from('main', { op: 'await', awaitId: 'await-bad', id: 'pty-1', until: 'soon', timeoutMs: 600_000 });
    from('main', { op: 'await', awaitId: 'await-nan', id: 'pty-1', until: 'exit', timeoutMs: 'forever' });
    // Nothing to answer to.
    from('main', { op: 'await', id: 'pty-1', until: 'exit', timeoutMs: 600_000 });
    await Promise.resolve();
    expect(results().map((result) => [result.awaitId, result.outcome.kind])).toEqual([
      ['await-bad', 'cancelled'],
      ['await-nan', 'cancelled'],
    ]);
    expect(alerts.manager.getState('pty-1').awaited).toBe(false);
  });

  it('survives a Workspace moving between windows: the manager never moves', async () => {
    from('main', { op: 'await', awaitId: 'await-1', id: 'pty-1', until: 'quiet', timeoutMs: 600_000 });
    // Ownership moves in Rust; the sidecar hears nothing of it, and `main` is
    // still open to hear the outcome.
    alerts.setWindows(['main', 'ws-2']);
    alerts.manager.notifyFromProtocol('pty-1', REPORT);
    await Promise.resolve();
    expect(results()).toEqual([
      { awaitId: 'await-1', window: 'main', outcome: expect.objectContaining({ kind: 'resolved', cause: 'bell' }) },
    ]);
  });
});

it('stops publishing once disposed', () => {
  alerts.dispose();
  from('main', { op: 'initializeWatchedCommands', names: ['npm test'] });
  expect(sent).toEqual([]);
});

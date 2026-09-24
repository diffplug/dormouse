import { describe, expect, it } from 'vitest';
import { createAlertClient } from './alert-client';
import { createAlertHost } from './alert-host';
import { ALERT_EVENTS, type AlertCommand } from './alert-protocol';
import type { AlertStateDetail } from '../lib/platform/types';
import { DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings-model';
import { REPORT } from '../lib/alert-manager-test-utils';

/**
 * A renderer realm's end of its host's alerts, shared by every adapter whose
 * host holds the manager: every `alert*` platform method is one command, and
 * every answer comes back as a host event (`docs/specs/alert.md`).
 */

function client() {
  const commands: AlertCommand[] = [];
  const alerts = createAlertClient((command) => void commands.push(command));
  return { alerts, methods: alerts.methods, commands };
}

it('sends each alert verb as one command naming its op', () => {
  const { alerts, methods, commands } = client();
  methods.alertDismiss('p');
  methods.alertAcknowledge('p');
  methods.alertToggleTodo('p');
  methods.alertClearTodo('p');
  methods.alertEngagement({ present: true, focusId: 'p' });
  methods.alertEngagement({ present: false, focusId: 'p' }, 'idle');
  methods.alertSetWatchedCommands(['cargo']);
  // A delta, never a replacement.
  methods.alertSetCommandWatched('cargo', true);
  methods.alertPublishSettings(DEFAULT_ALERT_SETTINGS, { seed: true });
  methods.alertPublishSettings(DEFAULT_ALERT_SETTINGS, { seed: false });
  alerts.hello();
  alerts.sync();
  expect(commands).toEqual([
    { op: 'dismiss', id: 'p' },
    { op: 'acknowledge', id: 'p' },
    { op: 'toggleTodo', id: 'p' },
    { op: 'clearTodo', id: 'p' },
    { op: 'engagement', state: { present: true, focusId: 'p' } },
    { op: 'engagement', state: { present: false, focusId: 'p' }, lapse: 'idle' },
    { op: 'initializeWatchedCommands', names: ['cargo'] },
    { op: 'setCommandWatched', name: 'cargo', watched: true },
    { op: 'initializeSettings', settings: DEFAULT_ALERT_SETTINGS },
    { op: 'updateSettings', settings: DEFAULT_ALERT_SETTINGS },
    { op: 'hello' },
    { op: 'sync' },
  ]);
});

describe('events', () => {
  it.each(ALERT_EVENTS)('claims %s, which every host sends', (event) => {
    expect(client().alerts.onEvent(event, null)).toBe(true);
  });

  it('hands the host\'s state and store snapshots to the renderer, and claims nothing else', () => {
    const { alerts, methods } = client();
    const seen: unknown[] = [];
    methods.onAlertState((detail) => void seen.push(['state', detail]));
    methods.onWatchedCommands((names) => void seen.push(['watched', names]));
    methods.onAlertSettings((settings) => void seen.push(['settings', settings]));

    const detail = { id: 'p', status: 'ALERT_RINGING', todo: true } as unknown as AlertStateDetail;
    alerts.onEvent('alert:state', detail);
    alerts.onEvent('alert:watchedCommands', { names: ['make'] });
    alerts.onEvent('alert:settings', { settings: DEFAULT_ALERT_SETTINGS });
    // A snapshot with no blob is dropped, not applied as "no settings".
    alerts.onEvent('alert:settings', {});
    expect(alerts.onEvent('pty:data', { id: 'p', data: 'x' })).toBe(false);

    expect(seen).toEqual([['state', detail], ['watched', ['make']], ['settings', DEFAULT_ALERT_SETTINGS]]);
  });
});

describe('awaits', () => {
  it('parks in the host and resolves on its own awaitId alone', async () => {
    const { alerts, methods, commands } = client();
    const handle = methods.alertAwait('p', { until: 'quiet', timeoutMs: 600_000 });
    const [parked] = commands as Array<Extract<AlertCommand, { op: 'await' }>>;
    expect(parked).toMatchObject({ op: 'await', id: 'p', until: 'quiet', timeoutMs: 600_000 });

    let outcome: unknown = null;
    void handle.promise.then((value) => { outcome = value; });
    alerts.onEvent('alert:awaitResult', { awaitId: 'await-other', outcome: { kind: 'timeout', waitedMs: 1 } });
    await Promise.resolve();
    expect(outcome).toBeNull();

    alerts.onEvent('alert:awaitResult', { awaitId: parked!.awaitId, outcome: { kind: 'resolved', cause: 'quiet', waitedMs: 7 } });
    await Promise.resolve();
    expect(outcome).toEqual({ kind: 'resolved', cause: 'quiet', waitedMs: 7 });
  });

  it('never mints an id another realm has', () => {
    const a = client();
    const b = client();
    a.methods.alertAwait('p', { until: 'exit', timeoutMs: 600_000 });
    b.methods.alertAwait('p', { until: 'exit', timeoutMs: 600_000 });
    const ids = [...a.commands, ...b.commands].map((command) => (command as { awaitId: string }).awaitId);
    expect(new Set(ids).size).toBe(2);
  });

  it('asks the host to cancel, and takes the answer the host sends', async () => {
    const { alerts, methods, commands } = client();
    const handle = methods.alertAwait('p', { until: 'exit', timeoutMs: 600_000 });
    const awaitId = (commands[0] as { awaitId: string }).awaitId;
    handle.cancel();
    expect(commands[1]).toEqual({ op: 'awaitCancel', awaitId });

    alerts.onEvent('alert:awaitResult', { awaitId, outcome: { kind: 'cancelled', waitedMs: 3 } });
    await expect(handle.promise).resolves.toEqual({ kind: 'cancelled', waitedMs: 3 });
    // Settled: a late cancel asks nothing more.
    handle.cancel();
    expect(commands).toHaveLength(2);
  });

  it('settles what it parked cancelled when disposed, since no answer can reach it', async () => {
    const { alerts, methods } = client();
    const handle = methods.alertAwait('p', { until: 'exit', timeoutMs: 600_000 });
    alerts.dispose();
    await expect(handle.promise).resolves.toMatchObject({ kind: 'cancelled' });
  });

  it('takes the host\'s answer through the real host, a claim included', async () => {
    const host = createAlertHost();
    const realm = createAlertClient((command) => host.handle('main', command, {
      answer: (result) => void realm.onEvent('alert:awaitResult', result),
      resendStates: () => {},
    }));
    try {
      const handle = realm.methods.alertAwait('p', { until: 'quiet', timeoutMs: 600_000 });
      host.manager.notifyFromProtocol('p', REPORT);
      await expect(handle.promise).resolves.toMatchObject({ kind: 'resolved', cause: 'bell' });
      // Claimed: the bell reached the program, not the human.
      expect(host.manager.getState('p').status).not.toBe('ALERT_RINGING');
    } finally {
      host.dispose();
    }
  });
});

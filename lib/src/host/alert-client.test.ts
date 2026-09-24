import { describe, expect, it } from 'vitest';
import { createSidecarAlertClient } from './alert-client';
import { createSidecarAlerts } from './alert-host';
import type { AlertCommand } from './alert-protocol';
import type { AlertStateDetail } from '../lib/platform/types';
import { DEFAULT_ALERT_SETTINGS } from '../lib/alert-settings-model';

/**
 * A standalone window's end of the sidecar's alerts: every `alert*` platform
 * method is one command, and every answer comes back as a sidecar event
 * (`docs/specs/standalone.md` → "Alerts").
 */

function client() {
  const commands: AlertCommand[] = [];
  const alerts = createSidecarAlertClient((command) => void commands.push(command));
  return { alerts, commands };
}

describe('commands', () => {
  it('sends each alert verb as one command naming its op', () => {
    const { alerts, commands } = client();
    alerts.alertDismiss('p');
    alerts.alertAcknowledge('p');
    alerts.alertResize('p');
    alerts.alertToggleTodo('p');
    alerts.alertClearTodo('p');
    alerts.alertRemove('p');
    alerts.alertSeed('p', { status: 'WATCHING_DISABLED', todo: true, notification: null });
    alerts.alertEngagement({ present: true, focusId: 'p' });
    alerts.alertEngagement({ present: false, focusId: 'p' }, 'idle');
    alerts.alertSetCommandWatched('cargo', true);
    alerts.hello();
    expect(commands).toEqual([
      { op: 'dismiss', id: 'p' },
      { op: 'acknowledge', id: 'p' },
      { op: 'resize', id: 'p' },
      { op: 'toggleTodo', id: 'p' },
      { op: 'clearTodo', id: 'p' },
      { op: 'remove', id: 'p' },
      { op: 'seed', id: 'p', state: { status: 'WATCHING_DISABLED', todo: true, notification: null } },
      { op: 'engagement', state: { present: true, focusId: 'p' } },
      { op: 'engagement', state: { present: false, focusId: 'p' }, lapse: 'idle' },
      { op: 'setCommandWatched', name: 'cargo', watched: true },
      { op: 'hello' },
    ]);
  });

  // The stream is the only path a store's snapshot takes back; a repeat seed is
  // refused as a seed but still answered (`lib/src/lib/watched-command-host.ts`).
  it('re-offers only its last seeds', () => {
    const { alerts, commands } = client();
    const quiet = { ...DEFAULT_ALERT_SETTINGS, speakEnabled: false };
    alerts.alertSetWatchedCommands(['cargo']);
    alerts.alertPublishSettings(quiet, { seed: true });
    // Neither a mutation nor a non-seed publish is a seed.
    alerts.alertSetCommandWatched('make', true);
    alerts.alertPublishSettings({ ...quiet, pushEnabled: true }, { seed: false });
    commands.length = 0;

    alerts.reofferSeeds();
    expect(commands).toEqual([
      { op: 'initializeWatchedCommands', names: ['cargo'] },
      { op: 'initializeSettings', settings: quiet },
    ]);
  });
});

describe('events', () => {
  it('hands the host\'s state and store snapshots to the renderer, and claims nothing else', () => {
    const { alerts } = client();
    const seen: unknown[] = [];
    alerts.onAlertState((detail) => void seen.push(['state', detail]));
    alerts.onWatchedCommands((names) => void seen.push(['watched', names]));
    alerts.onAlertSettings((settings) => void seen.push(['settings', settings]));

    const detail = { id: 'p', status: 'ALERT_RINGING', todo: true } as unknown as AlertStateDetail;
    expect(alerts.onEvent('alert:state', detail)).toBe(true);
    expect(alerts.onEvent('alert:watchedCommands', { names: ['make'] })).toBe(true);
    expect(alerts.onEvent('alert:settings', { settings: DEFAULT_ALERT_SETTINGS })).toBe(true);
    // A broadcast with no blob is dropped, not applied as "no settings".
    expect(alerts.onEvent('alert:settings', {})).toBe(true);
    expect(alerts.onEvent('pty:data', { id: 'p', data: 'x' })).toBe(false);

    expect(seen).toEqual([['state', detail], ['watched', ['make']], ['settings', DEFAULT_ALERT_SETTINGS]]);
  });
});

describe('awaits', () => {
  it('parks in the host and resolves on its own awaitId alone', async () => {
    const { alerts, commands } = client();
    const handle = alerts.alertAwait('p', { until: 'quiet', timeoutMs: 600_000 });
    const [parked] = commands as Array<Extract<AlertCommand, { op: 'await' }>>;
    expect(parked).toMatchObject({ op: 'await', id: 'p', until: 'quiet', timeoutMs: 600_000 });
    expect(parked!.awaitId).toMatch(/^await-/);

    let outcome: unknown = null;
    void handle.promise.then((value) => { outcome = value; });
    // Another window's await, broadcast to this one too.
    alerts.onEvent('alert:awaitResult', { awaitId: 'await-other', window: 'ws-2', outcome: { kind: 'timeout', waitedMs: 1 } });
    await Promise.resolve();
    expect(outcome).toBeNull();

    alerts.onEvent('alert:awaitResult', { awaitId: parked!.awaitId, window: 'main', outcome: { kind: 'resolved', cause: 'quiet', waitedMs: 7 } });
    await Promise.resolve();
    expect(outcome).toEqual({ kind: 'resolved', cause: 'quiet', waitedMs: 7 });
  });

  it('asks the host to cancel, and takes the answer the host sends', async () => {
    const { alerts, commands } = client();
    const handle = alerts.alertAwait('p', { until: 'exit', timeoutMs: 600_000 });
    const awaitId = (commands[0] as { awaitId: string }).awaitId;
    handle.cancel();
    expect(commands[1]).toEqual({ op: 'awaitCancel', awaitId });

    alerts.onEvent('alert:awaitResult', { awaitId, window: 'main', outcome: { kind: 'cancelled', waitedMs: 3 } });
    await expect(handle.promise).resolves.toEqual({ kind: 'cancelled', waitedMs: 3 });
    // Settled: a late cancel asks nothing more.
    handle.cancel();
    expect(commands).toHaveLength(2);
  });

  it('settles what it parked cancelled when disposed, since no answer can reach it', async () => {
    const { alerts } = client();
    const handle = alerts.alertAwait('p', { until: 'exit', timeoutMs: 600_000 });
    alerts.dispose();
    await expect(handle.promise).resolves.toMatchObject({ kind: 'cancelled' });
  });
});

/**
 * The whole path a reload takes, host and client wired as Rust wires them: the
 * manager never lived in the webview, so a reloaded window gets its rings and
 * TODOs back from the sidecar's answer to its collection, without seeding.
 */
it('gives a reloaded window its rings and TODOs back', () => {
  // The window's current realm: a reload replaces it under the same label.
  let realm: ReturnType<typeof createSidecarAlertClient> | null = null;
  const host = createSidecarAlerts({ send: (event, data) => realm?.onEvent(event, data) });
  const open = () => {
    realm = createSidecarAlertClient((command) => host.handle({ ...command, window: 'main' }));
    return realm;
  };
  try {
    const before = open();
    before.alertEngagement({ present: true, focusId: 'watched' });
    host.manager.notifyFromProtocol('ringing', { source: 'OSC 9', title: null, body: 'done' });
    before.alertToggleTodo('flagged');

    const after = open();
    const seen = new Map<string, AlertStateDetail>();
    after.onAlertState((detail) => void seen.set(detail.id, detail));
    after.hello();
    // What `pty:requestInit` makes the sidecar send behind its list.
    host.publish(['ringing', 'flagged']);

    expect(seen.get('ringing')).toMatchObject({ status: 'ALERT_RINGING', todo: true });
    expect(seen.get('flagged')).toMatchObject({ status: 'WATCHING_DISABLED', todo: true });
  } finally {
    host.dispose();
  }
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../lib/platform', () => ({
  getPlatform: () => ({ alertPublishSettings: vi.fn() }),
}));

import type { HostAclRecord } from 'server-lib-common';
import { refreshPushDevices, startAlertPush, toPushText } from './alert-push';
import { applyAlertSettingsFromHost, DEFAULT_ALERT_SETTINGS } from '../../lib/alert-settings';
import { getPushDevices, resetPushDevices } from '../../lib/push-devices';
import { clearPrimedActivity, primeActivity } from '../../lib/session-activity-store';

const PUSH_DELAY_MS = 20_000;

const ENROLLMENT = { serverUrl: 'https://relay.example', hostToken: 'host-token' };

function aclRecord(devicePublicKey: string, label: string): HostAclRecord {
  return {
    hostId: 'host-1',
    accountId: 'owner',
    passkeyCredentialId: 'cred',
    passkeyPublicKeyHash: 'hash',
    devicePublicKey,
    approvedAt: 1,
    approvedBy: 'host-user',
    label,
    revokedAt: null,
  };
}

/** Requests the sink made, in order. */
let requests: Array<{ url: string; init?: RequestInit }>;
let subscribed: string[];
let records: HostAclRecord[];
let stop: (() => void) | null = null;

function fakeFetch(): typeof globalThis.fetch {
  return (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    requests.push({ url, init });
    if (url.endsWith('/api/push/devices')) {
      return {
        ok: true,
        json: async () => ({
          devices: subscribed.map((devicePublicKey) => ({ devicePublicKey, subscribedAt: 1 })),
        }),
      } as Response;
    }
    return {
      ok: true,
      json: async () => ({ delivered: 1, expired: 0, unknown: 0, failed: 0 }),
    } as Response;
  }) as unknown as typeof globalThis.fetch;
}

function deps() {
  return { enrollment: ENROLLMENT, activeRecords: () => records, fetch: fakeFetch() };
}

function ring(id: string): void {
  primeActivity(id, { status: 'NOTHING_TO_SHOW' });
  primeActivity(id, { status: 'ALERT_RINGING' });
}

/** The body of the last `push/send` request, parsed. */
function lastSend(): Record<string, unknown> | null {
  const send = requests.filter((r) => r.url.endsWith('/api/push/send')).at(-1);
  return send ? (JSON.parse(String(send.init?.body)) as Record<string, unknown>) : null;
}

beforeEach(() => {
  vi.useFakeTimers();
  requests = [];
  subscribed = ['device-phone'];
  records = [aclRecord('device-phone', 'iPhone Safari')];
  clearPrimedActivity();
  resetPushDevices();
  applyAlertSettingsFromHost({
    ...DEFAULT_ALERT_SETTINGS,
    pushEnabled: true,
    pushDelayMs: PUSH_DELAY_MS,
  });
});

afterEach(() => {
  stop?.();
  stop = null;
  clearPrimedActivity();
  resetPushDevices();
  applyAlertSettingsFromHost(DEFAULT_ALERT_SETTINGS);
  vi.useRealTimers();
});

/**
 * A push payload crosses a network to a third-party push service and is
 * rendered by the OS, and the label it carries is ultimately terminal-supplied
 * (`docs/specs/alert.md` -> Text And Security).
 */
describe('toPushText', () => {
  it('keeps ordinary labels intact, including angle brackets', () => {
    // Unlike speech: the bracket rule exists only because WebKit's synthesizer
    // wedges on them, which has nothing to do with a notification.
    expect(toPushText('<idle> zsh')).toBe('<idle> zsh');
  });

  it('replaces control characters with spaces', () => {
    expect(toPushText('build\u0000finished\u001b')).toBe('build finished');
  });

  it('strips bidi overrides that could reorder text on a lock screen', () => {
    expect(toPushText('build ‮finished')).toBe('build finished');
  });

  it('strips the Arabic letter mark with the rest of the bidi set', () => {
    expect(toPushText('a؜b')).toBe('ab');
  });

  it('never cuts a surrogate pair at the cap', () => {
    // A UTF-16 slice landing mid-surrogate would ship a lone half that the
    // phone renders as U+FFFD.
    const capped = toPushText('x'.repeat(99) + '🚀');
    expect(capped.endsWith('🚀')).toBe(true);
  });

  it('strips zero-width characters rather than spacing them out', () => {
    expect(toPushText('bu​ild')).toBe('build');
  });

  it('collapses whitespace', () => {
    expect(toPushText('  build   finished \n')).toBe('build finished');
  });

  it('caps a pathological title', () => {
    expect(toPushText('x'.repeat(500))).toHaveLength(100);
  });

  it('falls back when nothing survives', () => {
    expect(toPushText('\u0000\u200b   ')).toBe('terminal');
  });
});

describe('alarm push', () => {
  it('sends the pane label after the delay, tagged per Session', async () => {
    stop = startAlertPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS - 1);
    expect(lastSend()).toBeNull();

    await vi.advanceTimersByTimeAsync(1);
    expect(lastSend()).toMatchObject({
      title: 'terminal',
      tag: 'pty-1',
      devicePublicKeys: ['device-phone'],
    });
  });

  it('sends nothing while pushEnabled is off', async () => {
    applyAlertSettingsFromHost({ ...DEFAULT_ALERT_SETTINGS, pushEnabled: false });
    stop = startAlertPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(60_000);
    expect(lastSend()).toBeNull();
  });

  it('uses pushDelayMs as the delay', async () => {
    applyAlertSettingsFromHost({
      ...DEFAULT_ALERT_SETTINGS,
      pushEnabled: true,
      pushDelayMs: 5_000,
    });
    stop = startAlertPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(5_000);
    expect(lastSend()).not.toBeNull();
  });

  it('names only devices still active in the ACL', async () => {
    // The server still holds a subscription for a revoked client — nothing
    // propagates a revocation — so the Host must not address it. It stays out
    // of the request because the ACL, not the server's list, chooses targets.
    subscribed = ['device-phone', 'device-revoked'];
    records = [aclRecord('device-phone', 'iPhone Safari')];
    stop = startAlertPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(lastSend()).toMatchObject({ devicePublicKeys: ['device-phone'] });
  });

  it('costs one request per alarm, not a lookup then a send', async () => {
    // The ACL is local, and the Server intersects the names it is given with
    // its own subscriptions anyway — so asking it first would only add a round
    // trip to the one path whose whole value is timeliness.
    stop = startAlertPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.url).toContain('/api/push/send');
  });

  it('warns when the server accepted the send but no phone got it', async () => {
    // The send route answers 200 with counts even when every delivery failed —
    // a rotated VAPID key or a wedged push service must not be silent.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = startAlertPush({
      enrollment: ENROLLMENT,
      activeRecords: () => records,
      fetch: (async () => ({
        ok: true,
        json: async () => ({ delivered: 0, expired: 0, unknown: 0, failed: 1 }),
      })) as unknown as typeof globalThis.fetch,
    });
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('warns rather than failing silently when the server rejects the send', async () => {
    // A 401 from a revoked host token would otherwise resolve normally and
    // leave push permanently broken with nothing in the console.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = startAlertPush({
      enrollment: ENROLLMENT,
      activeRecords: () => records,
      fetch: (async () => ({ ok: false, status: 401 })) as unknown as typeof globalThis.fetch,
    });
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it('sends nothing when no subscribed device is still authorized', async () => {
    records = [];
    stop = startAlertPush(deps());
    ring('pty-1');

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(lastSend()).toBeNull();
  });

  it('re-reads the target list at send time, not at schedule time', async () => {
    stop = startAlertPush(deps());
    ring('pty-1');
    // Revoked during the delay.
    records = [];

    await vi.advanceTimersByTimeAsync(PUSH_DELAY_MS);
    expect(lastSend()).toBeNull();
  });

  it('survives a server that cannot be reached', async () => {
    const failing = {
      enrollment: ENROLLMENT,
      activeRecords: () => records,
      fetch: (async () => {
        throw new Error('network down');
      }) as unknown as typeof globalThis.fetch,
    };
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    stop = startAlertPush(failing);
    ring('pty-1');

    await expect(vi.advanceTimersByTimeAsync(60_000)).resolves.not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

describe('push device list', () => {
  it('joins server subscriptions to ACL labels', async () => {
    await refreshPushDevices(deps());
    expect(getPushDevices()).toEqual({
      status: 'ready',
      devices: [{ devicePublicKey: 'device-phone', label: 'iPhone Safari' }],
    });
  });

  it('omits a subscribed device that is no longer in the ACL', async () => {
    subscribed = ['device-phone', 'device-revoked'];
    await refreshPushDevices(deps());
    expect(getPushDevices().devices).toEqual([
      { devicePublicKey: 'device-phone', label: 'iPhone Safari' },
    ]);
  });

  it('reports error rather than an empty list when the server is unreachable', async () => {
    // "We could not ask" and "nothing is subscribed" must not look the same.
    await refreshPushDevices({
      enrollment: ENROLLMENT,
      activeRecords: () => records,
      fetch: (async () => ({ ok: false, status: 500 })) as unknown as typeof globalThis.fetch,
    });
    expect(getPushDevices()).toEqual({ status: 'error', devices: [] });
  });

  it('discards a refresh that resolves after the Host stopped', async () => {
    // Without the generation fence, the resolving fetch would overwrite the
    // reset's `no-host` with a `ready` list naming devices nothing can reach —
    // and since the reset cleared the refresher, it would stick all session.
    let resolveFetch: (response: Response) => void = () => {};
    const pending = refreshPushDevices({
      enrollment: ENROLLMENT,
      activeRecords: () => records,
      fetch: (() =>
        new Promise((resolve) => {
          resolveFetch = resolve;
        })) as unknown as typeof globalThis.fetch,
    });

    resetPushDevices();
    resolveFetch({
      ok: true,
      json: async () => ({ devices: [{ devicePublicKey: 'device-phone', subscribedAt: 1 }] }),
    } as Response);
    await pending;

    expect(getPushDevices()).toEqual({ status: 'no-host', devices: [] });
  });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pushEndpointFingerprint } from 'remote-lib-common';

const getRegistration = vi.fn();
vi.mock('../pocket-app/service-worker', () => ({
  getPushServiceWorkerRegistration: () => getRegistration(),
}));

import {
  getPushAvailability,
  hasCurrentPushSubscription,
  isInstalledWebApp,
  requiresInstallForPush,
  subscribeToPushInBrowser,
} from './push-subscribe';

/**
 * Stub the browser surface these helpers read. Every field is opt-out so a case
 * can remove exactly one capability and leave the rest realistic.
 */
function stubBrowser({
  serviceWorker = true,
  notification = true,
  pushManager = true,
  permission = 'default',
  standalone,
  displayModeStandalone = false,
}: {
  serviceWorker?: boolean;
  notification?: boolean;
  pushManager?: boolean;
  permission?: NotificationPermission;
  /** Undefined models a non-iOS browser, where the property does not exist. */
  standalone?: boolean;
  displayModeStandalone?: boolean;
} = {}): void {
  const nav: Record<string, unknown> = {};
  if (serviceWorker) nav.serviceWorker = {};
  if (standalone !== undefined) nav.standalone = standalone;
  vi.stubGlobal('navigator', nav);
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.includes('standalone') && displayModeStandalone,
  }));
  if (notification) {
    const NotificationStub = function () {} as unknown as typeof Notification;
    (NotificationStub as unknown as { permission: NotificationPermission }).permission = permission;
    vi.stubGlobal('Notification', NotificationStub);
  } else {
    vi.stubGlobal('Notification', undefined);
  }
  if (pushManager) vi.stubGlobal('PushManager', function () {});
  else vi.stubGlobal('PushManager', undefined);
}

/** A registration whose pushManager reports `subscription` as the current one. */
function registration(subscription: unknown = null) {
  return { pushManager: { getSubscription: async () => subscription } };
}

beforeEach(() => {
  getRegistration.mockReset();
  getRegistration.mockResolvedValue(registration());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('isInstalledWebApp', () => {
  it('is true when iOS reports standalone', () => {
    stubBrowser({ standalone: true });
    expect(isInstalledWebApp()).toBe(true);
  });

  it('is true when the standard display-mode query matches', () => {
    stubBrowser({ displayModeStandalone: true });
    expect(isInstalledWebApp()).toBe(true);
  });

  it('is false in an ordinary tab', () => {
    stubBrowser({ standalone: false });
    expect(isInstalledWebApp()).toBe(false);
  });
});

describe('requiresInstallForPush', () => {
  it('is true on iOS, detected by the property existing at all', () => {
    // Even `false` means iOS: the property is iOS/iPadOS Safari only.
    stubBrowser({ standalone: false });
    expect(requiresInstallForPush()).toBe(true);
  });

  it('is false where the property is absent', () => {
    // macOS Safari, Chrome, Firefox — Web Push works in a plain tab there, so
    // an install prompt would be wrong.
    stubBrowser({});
    expect(requiresInstallForPush()).toBe(false);
  });
});

describe('getPushAvailability', () => {
  it('reports ready when everything is in place', async () => {
    stubBrowser({});
    await expect(getPushAvailability()).resolves.toBe('ready');
  });

  it('reports ready when a scope-wide subscription already exists', async () => {
    stubBrowser({});
    getRegistration.mockResolvedValue(registration({ endpoint: 'https://push.example/x' }));
    await expect(getPushAvailability()).resolves.toBe('ready');
  });

  it('reports unsupported without a service worker', async () => {
    stubBrowser({ serviceWorker: false });
    await expect(getPushAvailability()).resolves.toBe('unsupported');
  });

  it('reports unsupported without the Notification API', async () => {
    stubBrowser({ notification: false });
    await expect(getPushAvailability()).resolves.toBe('unsupported');
  });

  it('reports needs-install on iOS in a tab', async () => {
    stubBrowser({ standalone: false });
    await expect(getPushAvailability()).resolves.toBe('needs-install');
  });

  it('does not report needs-install once installed on iOS', async () => {
    stubBrowser({ standalone: true });
    await expect(getPushAvailability()).resolves.toBe('ready');
  });

  it('prefers needs-install over unsupported on iOS, where PushManager is simply absent', async () => {
    // Reporting "unsupported" here would be true but useless — the user can fix
    // it by installing.
    stubBrowser({ standalone: false, pushManager: false });
    await expect(getPushAvailability()).resolves.toBe('needs-install');
  });

  it('prefers needs-install over unsupported on iOS, where Notification is also absent in a tab', async () => {
    // The real iOS Safari tab shape: service workers exist, but the
    // Notification interface itself is exposed only to installed web apps.
    stubBrowser({ standalone: false, notification: false, pushManager: false });
    await expect(getPushAvailability()).resolves.toBe('needs-install');
  });

  it('reports no-worker when registration failed', async () => {
    stubBrowser({});
    getRegistration.mockResolvedValue(null);
    await expect(getPushAvailability()).resolves.toBe('no-worker');
  });

  it('reports denied when permission was refused', async () => {
    stubBrowser({ permission: 'denied' });
    await expect(getPushAvailability()).resolves.toBe('denied');
  });

  it('waits for an in-flight registration rather than calling it a failure', async () => {
    stubBrowser({});
    let resolve: (value: unknown) => void = () => {};
    getRegistration.mockReturnValue(new Promise((r) => { resolve = r; }));
    const pending = getPushAvailability();
    resolve(registration());
    await expect(pending).resolves.toBe('ready');
  });
});

describe('hasCurrentPushSubscription', () => {
  it('accepts a granted subscription minted for the current VAPID key', async () => {
    stubBrowser({ permission: 'granted' });
    getRegistration.mockResolvedValue(
      registration({
        options: { applicationServerKey: Uint8Array.of(1, 2, 3).buffer },
      }),
    );

    await expect(hasCurrentPushSubscription('AQID', null)).resolves.toBe(true);
  });

  it('rejects a subscription minted for an old VAPID key', async () => {
    stubBrowser({ permission: 'granted' });
    getRegistration.mockResolvedValue(
      registration({
        options: { applicationServerKey: Uint8Array.of(9, 9, 9).buffer },
      }),
    );

    await expect(hasCurrentPushSubscription('AQID', null)).resolves.toBe(false);
  });

  it('rejects a stored subscription after notification permission is revoked', async () => {
    stubBrowser({ permission: 'denied' });
    getRegistration.mockResolvedValue(
      registration({
        options: { applicationServerKey: Uint8Array.of(1, 2, 3).buffer },
      }),
    );

    await expect(hasCurrentPushSubscription('AQID', null)).resolves.toBe(false);
  });

  it('rejects a missing browser subscription even if the Server may still hold a row', async () => {
    stubBrowser({ permission: 'granted' });
    getRegistration.mockResolvedValue(registration(null));

    await expect(hasCurrentPushSubscription('AQID', null)).resolves.toBe(false);
  });

  it('rejects an endpoint the push service rotated behind our back', async () => {
    // The VAPID key still matches and the subscription is perfectly valid — it
    // just points somewhere new, so every row the Server holds is unreachable.
    stubBrowser({ permission: 'granted' });
    getRegistration.mockResolvedValue(
      registration({
        endpoint: 'https://push.example/rotated',
        options: { applicationServerKey: Uint8Array.of(1, 2, 3).buffer },
      }),
    );
    const registered = await pushEndpointFingerprint('https://push.example/original');

    await expect(hasCurrentPushSubscription('AQID', registered)).resolves.toBe(false);
  });

  it('accepts the endpoint that was actually registered', async () => {
    stubBrowser({ permission: 'granted' });
    getRegistration.mockResolvedValue(
      registration({
        endpoint: 'https://push.example/original',
        options: { applicationServerKey: Uint8Array.of(1, 2, 3).buffer },
      }),
    );
    const registered = await pushEndpointFingerprint('https://push.example/original');

    await expect(hasCurrentPushSubscription('AQID', registered)).resolves.toBe(true);
  });
});

describe('subscribeToPushInBrowser', () => {
  it('explains a missing worker instead of hanging on serviceWorker.ready', async () => {
    stubBrowser({});
    getRegistration.mockResolvedValue(null);
    await expect(subscribeToPushInBrowser('BKey', () => {})).rejects.toThrow(/background worker/i);
  });

  it('does not prompt for permission when there is no worker to subscribe with', async () => {
    stubBrowser({});
    getRegistration.mockResolvedValue(null);
    const requestPermission = vi.fn();
    (globalThis.Notification as unknown as { requestPermission: unknown }).requestPermission =
      requestPermission;

    await expect(subscribeToPushInBrowser('BKey', () => {})).rejects.toThrow();
    expect(requestPermission).not.toHaveBeenCalled();
  });

  it('surfaces a denial with a message that names the fix', async () => {
    stubBrowser({});
    (globalThis.Notification as unknown as { requestPermission: unknown }).requestPermission =
      async () => 'denied';
    await expect(subscribeToPushInBrowser('BKey', () => {})).rejects.toThrow(/browser settings/i);
  });

  it('reuses a scope-wide subscription minted for the same VAPID key', async () => {
    stubBrowser({});
    (globalThis.Notification as unknown as { requestPermission: unknown }).requestPermission =
      async () => 'granted';
    const unsubscribe = vi.fn();
    const subscribe = vi.fn();
    const existing = {
      endpoint: 'https://push.example/existing',
      options: { applicationServerKey: Uint8Array.of(1, 2, 3).buffer },
      unsubscribe,
      toJSON: () => ({
        endpoint: 'https://push.example/existing',
        keys: { p256dh: 'p256dh', auth: 'auth' },
      }),
    };
    getRegistration.mockResolvedValue({
      pushManager: { getSubscription: async () => existing, subscribe },
    });
    const onReplaced = vi.fn();

    await expect(subscribeToPushInBrowser('AQID', onReplaced)).resolves.toEqual({
      endpoint: 'https://push.example/existing',
      keys: { p256dh: 'p256dh', auth: 'auth' },
    });
    expect(unsubscribe).not.toHaveBeenCalled();
    expect(subscribe).not.toHaveBeenCalled();
    // The address other Hosts registered is still live, so nothing was replaced.
    expect(onReplaced).not.toHaveBeenCalled();
  });

  it('rotates the subscription when the VAPID key changed', async () => {
    stubBrowser({});
    (globalThis.Notification as unknown as { requestPermission: unknown }).requestPermission =
      async () => 'granted';
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const replacement = {
      endpoint: 'https://push.example/replacement',
      toJSON: () => ({
        endpoint: 'https://push.example/replacement',
        keys: { p256dh: 'new-p256dh', auth: 'new-auth' },
      }),
    };
    const subscribe = vi.fn().mockResolvedValue(replacement);
    getRegistration.mockResolvedValue({
      pushManager: {
        getSubscription: async () => ({
          options: { applicationServerKey: Uint8Array.of(9, 9, 9).buffer },
          unsubscribe,
        }),
        subscribe,
      },
    });

    const onReplaced = vi.fn();

    await expect(subscribeToPushInBrowser('AQID', onReplaced)).resolves.toEqual({
      endpoint: 'https://push.example/replacement',
      keys: { p256dh: 'new-p256dh', auth: 'new-auth' },
    });
    expect(onReplaced).toHaveBeenCalledOnce();
    expect(unsubscribe).toHaveBeenCalledOnce();
    expect(subscribe).toHaveBeenCalledWith({
      userVisibleOnly: true,
      applicationServerKey: Uint8Array.of(1, 2, 3),
    });
  });

  it('reports the replaced delivery address even when subscribe throws', async () => {
    // The old endpoint is dead as soon as `unsubscribe` resolves. If the
    // failure swallowed that fact, every other Host would keep claiming push
    // notifications through an address nothing can reach.
    stubBrowser({});
    (globalThis.Notification as unknown as { requestPermission: unknown }).requestPermission =
      async () => 'granted';
    const unsubscribe = vi.fn().mockResolvedValue(true);
    const subscribe = vi.fn().mockRejectedValue(new Error('push service unreachable'));
    getRegistration.mockResolvedValue({
      pushManager: {
        getSubscription: async () => ({
          options: { applicationServerKey: Uint8Array.of(9, 9, 9).buffer },
          unsubscribe,
        }),
        subscribe,
      },
    });
    const onReplaced = vi.fn();

    await expect(subscribeToPushInBrowser('AQID', onReplaced)).rejects.toThrow(
      'push service unreachable',
    );
    expect(onReplaced).toHaveBeenCalledOnce();
  });
});

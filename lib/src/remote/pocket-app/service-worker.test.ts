/**
 * How Pocket registers its worker (`docs/specs/pocket-app.md` -> Installable
 * web app). The worker's own behavior is `sw.test.ts`.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getPushServiceWorkerRegistration, registerPushServiceWorker } from './service-worker';

function fakeServiceWorkerContainer(register: ReturnType<typeof vi.fn>) {
  vi.stubGlobal('navigator', { serviceWorker: { register } });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('registerPushServiceWorker', () => {
  /**
   * The worker is bundled as one classic IIFE, so this call must stay classic:
   * `type: 'module'` would ask for module semantics the built file does not
   * have. `lib/scripts/assert-pocket-worker.mjs` holds the other end.
   */
  it('registers /sw.js at the root scope, classic', async () => {
    const registration = { scope: '/' };
    const register = vi.fn(async () => registration);
    fakeServiceWorkerContainer(register);

    registerPushServiceWorker();

    expect(register).toHaveBeenCalledWith('/sw.js', { scope: '/' });
    expect(register.mock.calls[0]![1]).not.toHaveProperty('type');
    await expect(getPushServiceWorkerRegistration()).resolves.toBe(registration);
  });

  it('warns and resolves null when registration fails', async () => {
    // Ordinary on an insecure origin and in a browser without support; every
    // screen works without the worker, so boot must not depend on it.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    fakeServiceWorkerContainer(vi.fn(async () => Promise.reject(new Error('insecure origin'))));

    registerPushServiceWorker();

    await expect(getPushServiceWorkerRegistration()).resolves.toBeNull();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});

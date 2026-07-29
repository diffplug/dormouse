import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

type WorkerListener = (event: {
  data?: { json(): unknown };
  waitUntil(promise: Promise<unknown>): void;
}) => void;

describe('Pocket push service worker', () => {
  it('strips controls, bidi marks, and zero-width characters at the notification sink', async () => {
    const listeners = new Map<string, WorkerListener>();
    const showNotification = vi.fn(async () => undefined);
    const self = {
      addEventListener: (type: string, listener: WorkerListener) => {
        listeners.set(type, listener);
      },
      skipWaiting: () => undefined,
      clients: {
        claim: async () => undefined,
        matchAll: async () => [],
        openWindow: async () => undefined,
      },
      registration: { showNotification },
    };
    const source = readFileSync(new URL('../../../pocket/public/sw.js', import.meta.url), 'utf8');
    runInNewContext(source, { self });

    let pending: Promise<unknown> | undefined;
    listeners.get('push')!({
      data: {
        json: () => ({
          title: 'safe\u0000\u202ehidden\u200b',
          body: 'body\u0085text\u2066\ufeff',
        }),
      },
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;

    expect(showNotification).toHaveBeenCalledWith(
      'safe hidden',
      expect.objectContaining({ body: 'body text' }),
    );
  });
});

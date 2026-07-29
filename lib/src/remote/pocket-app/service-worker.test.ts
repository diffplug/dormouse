import { readFileSync } from 'node:fs';
import { createContext, runInContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

import { boundedPushText } from 'server-lib-common';

type WorkerListener = (event: {
  data?: { json(): unknown; text?(): string };
  waitUntil(promise: Promise<unknown>): void;
}) => void;

interface WorkerHarness {
  listeners: Map<string, WorkerListener>;
  showNotification: ReturnType<typeof vi.fn>;
  /** The worker's own `text()`, pulled out of its realm. */
  text: (value: unknown, fallback: string) => string;
  textLimit: number;
}

/**
 * Execute the real `sw.js` against a stub `self`.
 *
 * The file is copied verbatim into the build — never bundled, never
 * typechecked — so running the shipped artifact is the only way to cover it.
 * Its top-level declarations live in the context's global scope, which is how
 * the assertions below reach `text` and `TEXT_LIMIT` without exporting them.
 */
function loadWorker(): WorkerHarness {
  const listeners = new Map<string, WorkerListener>();
  const showNotification = vi.fn(async () => undefined);
  const context = createContext({
    self: {
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
    },
  });
  const source = readFileSync(new URL('../../../pocket/public/sw.js', import.meta.url), 'utf8');
  runInContext(source, context);
  return {
    listeners,
    showNotification,
    text: runInContext('text', context) as WorkerHarness['text'],
    textLimit: runInContext('TEXT_LIMIT', context) as number,
  };
}

describe('Pocket push service worker', () => {
  it('pins the render-sink cap to the Server rule', () => {
    // The mirror corpus below borrows `TEXT_LIMIT` from the worker itself, so
    // without this literal a drifted limit would still pass every assertion.
    // 200 is the Server's `PUSH_TEXT_LIMIT` (`server/src/app.ts`).
    expect(loadWorker().textLimit).toBe(200);
  });

  it('shows the generic notification for a payload-less push', async () => {
    // `userVisibleOnly` promises the browser every delivery becomes visible;
    // returning early would incur the penalty notice instead.
    const { listeners, showNotification } = loadWorker();

    let pending: Promise<unknown> | undefined;
    listeners.get('push')!({
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;

    expect(showNotification).toHaveBeenCalledWith(
      'Dormouse',
      expect.objectContaining({ body: 'A terminal needs attention.' }),
    );
  });

  it('surfaces raw text when the payload is not JSON', async () => {
    const { listeners, showNotification } = loadWorker();

    let pending: Promise<unknown> | undefined;
    listeners.get('push')!({
      data: {
        json: () => {
          throw new Error('not json');
        },
        text: () => 'plain alarm',
      },
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;

    expect(showNotification).toHaveBeenCalledWith(
      'Dormouse',
      expect.objectContaining({ body: 'plain alarm' }),
    );
  });

  it('still notifies when both payload reads throw', async () => {
    const { listeners, showNotification } = loadWorker();

    let pending: Promise<unknown> | undefined;
    listeners.get('push')!({
      data: {
        json: () => {
          throw new Error('not json');
        },
        text: () => {
          throw new Error('unreadable');
        },
      },
      waitUntil: (promise) => {
        pending = promise;
      },
    });
    await pending;

    expect(showNotification).toHaveBeenCalledWith(
      'Dormouse',
      expect.objectContaining({ body: 'A terminal needs attention.' }),
    );
  });

  it('strips controls, bidi marks, and zero-width characters at the notification sink', async () => {
    const { listeners, showNotification } = loadWorker();

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

  /**
   * The worker cannot import `boundedPushText` — it is a classic worker copied
   * verbatim — so the shared rule exists twice. The spec says one mirrors the
   * other; this is what makes that enforceable rather than a promise in a
   * comment. A deliberate change to either must be made in both.
   */
  it('applies the same rule as the shared boundedPushText', () => {
    const { text, textLimit } = loadWorker();
    const fallback = 'FALLBACK';
    const corpus = [
      'build finished',
      '<idle> zsh',
      'build\u0000finished\u001b',
      'nel\u0085next',
      'build \u202ereversed',
      'zero\u200bwidth\u2060joiner',
      'isolate\u2066text\u2069end',
      'arabic\u061cmark',
      '\ufeffbom',
      '  collapse   me \n\t ',
      '',
      '   ',
      '\u0000\u200b   ',
      'ünïcödé ✓ 日本語',
      'x'.repeat(textLimit + 50),
      'a'.repeat(textLimit - 1),
      // An astral code point straddling the cap: both copies must cut on the
      // code-point boundary, never mid-surrogate.
      'a'.repeat(textLimit - 1) + '🚀🚀',
    ];

    for (const value of corpus) {
      expect(text(value, fallback)).toBe(boundedPushText(value, { limit: textLimit, fallback }));
    }
  });

  it('never splits a surrogate pair at the cap', () => {
    // Mirror equality alone would also pass if both copies shipped the same
    // lone half; this pins the actual behavior.
    const { text, textLimit } = loadWorker();
    const capped = text('a'.repeat(textLimit - 1) + '🚀', 'FALLBACK');
    expect(capped.endsWith('🚀')).toBe(true);
  });

  it('falls back for non-string fields exactly as the shared rule does', () => {
    const { text, textLimit } = loadWorker();
    const fallback = 'FALLBACK';
    for (const value of [undefined, null, 42, {}, [], true]) {
      expect(text(value, fallback)).toBe(boundedPushText(value, { limit: textLimit, fallback }));
    }
  });
});

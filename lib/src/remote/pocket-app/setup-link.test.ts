/**
 * @vitest-environment jsdom
 *
 * The `#setup?token=…&nonce=…` hash a Host's QR carries: what is read out of it,
 * and — the half that is a security property rather than a parse — that the
 * secrets are gone from the URL the moment they have been read.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { takeSetupHash } from './setup-link';

const TOKEN = '3PkQ8sV2mYb1hZr7Lw0cJdN6xTgAeUiOpqRsFuHv9Kz';
const NONCE = 'Zm9vYmFyLXNldHVwLW5vbmNlLTMyLWJ5dGVzLWI2NHU';

/** Put the app at a URL carrying `hash`, the way a scanned QR opens it. */
function openWith(hash: string): void {
  history.replaceState(null, '', `/${hash}`);
}

afterEach(() => {
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('takeSetupHash', () => {
  it('reads both halves of a scanned code', () => {
    openWith(`#setup?token=${TOKEN}&nonce=${NONCE}`);

    expect(takeSetupHash()).toEqual({ token: TOKEN, nonce: NONCE });
  });

  it('erases the hash, so neither secret survives in the URL', () => {
    openWith(`#setup?token=${TOKEN}&nonce=${NONCE}`);

    takeSetupHash();

    expect(location.hash).toBe('');
    expect(location.href).not.toContain(TOKEN);
    expect(location.href).not.toContain(NONCE);
  });

  it('replaces the entry rather than pushing one, so Back cannot restore it', () => {
    openWith(`#setup?token=${TOKEN}`);
    const replaceState = vi.spyOn(history, 'replaceState');
    const pushState = vi.spyOn(history, 'pushState');

    takeSetupHash();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('keeps the path and query it was opened at', () => {
    history.replaceState(null, '', `/?utm=qr#setup?token=${TOKEN}`);

    takeSetupHash();

    expect(location.pathname).toBe('/');
    expect(location.search).toBe('?utm=qr');
  });

  it('takes a token with no nonce — pairing simply falls back to the compare', () => {
    openWith(`#setup?token=${TOKEN}`);

    expect(takeSetupHash()).toEqual({ token: TOKEN });
  });

  it('drops a malformed nonce but keeps the token that still redeems', () => {
    openWith(`#setup?token=${TOKEN}&nonce=${'x'.repeat(500)}`);

    expect(takeSetupHash()).toEqual({ token: TOKEN });
  });

  it.each([
    ['no token', '#setup?nonce=abc'],
    ['an empty token', '#setup?token='],
    ['a token outside base64url', '#setup?token=not%20a%20token'],
    ['a token past the bound', `#setup?token=${'A'.repeat(200)}`],
  ])('ignores a code with %s, and still erases it', (_case, hash) => {
    openWith(hash);

    // Ignored, not reported: the person holding the phone did not type this.
    expect(takeSetupHash()).toBeNull();
    expect(location.hash).toBe('');
  });

  it('leaves a hash that is not a setup code alone', () => {
    openWith('#somewhere-else');

    expect(takeSetupHash()).toBeNull();
    expect(location.hash).toBe('#somewhere-else');
  });

  it('reads nothing from a plain visit', () => {
    expect(takeSetupHash()).toBeNull();
  });
});

describe('scannedSetup', () => {
  /**
   * The capture has to happen at module load, before React renders: StrictMode
   * runs a mounting tree twice, and a hook-time read would find the hash the
   * first pass had already erased.
   */
  it('is captured when the module loads, and erases the hash then', async () => {
    openWith(`#setup?token=${TOKEN}&nonce=${NONCE}`);
    vi.resetModules();

    const { scannedSetup } = await import('./setup-link');

    expect(scannedSetup).toEqual({ token: TOKEN, nonce: NONCE });
    expect(location.hash).toBe('');
  });
});

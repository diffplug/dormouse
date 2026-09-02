/**
 * @vitest-environment jsdom
 *
 * The `#pair?` fragment a native camera delivers: that it is gone from the URL
 * the moment it has been noticed, and that noticing is *all* that happens —
 * nothing parsed, nothing kept, nothing spent (`docs/specs/pocket-app.md` →
 * the auth screen).
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import { takePairingHash } from './pair-link';

const TOKEN = '3PkQ8sV2mYb1hZr7Lw0cJdN6xTgAeUiOpqRsFuHv9Kz';
const EPH_PUB = 'AAECAwQFBgcICQoLDA0ODxAREhMUFRYXGBkaGxwdHh8';
const FRAGMENT = `#pair?1.AAECAwQFBgcICQoLDA0ODw.8O_u7ezr6uno5-bl5OPi4Q.1700000300.${TOKEN}.${EPH_PUB}`;

/** Put the app at a URL carrying `hash`, the way a scanned QR opens it. */
function openWith(hash: string): void {
  history.replaceState(null, '', `/${hash}`);
}

afterEach(() => {
  history.replaceState(null, '', '/');
  vi.restoreAllMocks();
});

describe('takePairingHash', () => {
  it('erases the fragment, so no secret in it survives in the URL', () => {
    openWith(FRAGMENT);

    expect(takePairingHash()).toBe(true);

    expect(location.hash).toBe('');
    expect(location.href).not.toContain(TOKEN);
    expect(location.href).not.toContain(EPH_PUB);
  });

  /**
   * A hash saying `#pair?` carries a live setup token whether or not the rest
   * of it is well-formed, so the erase cannot be conditional on a parse.
   */
  it('erases a malformed fragment too, and still reports the arrival', () => {
    openWith('#pair?not-a-real-fragment');

    expect(takePairingHash()).toBe(true);
    expect(location.hash).toBe('');
  });

  it('replaces the entry rather than pushing one, so Back cannot restore it', () => {
    openWith(FRAGMENT);
    const replaceState = vi.spyOn(history, 'replaceState');
    const pushState = vi.spyOn(history, 'pushState');

    takePairingHash();

    expect(replaceState).toHaveBeenCalledOnce();
    expect(pushState).not.toHaveBeenCalled();
  });

  it('leaves the path and query alone', () => {
    history.replaceState(null, '', `/?utm=x${FRAGMENT}`);

    takePairingHash();

    expect(location.pathname).toBe('/');
    expect(location.search).toBe('?utm=x');
  });

  it('does nothing at all without a pairing fragment', () => {
    openWith('#something-else');
    const replaceState = vi.spyOn(history, 'replaceState');

    expect(takePairingHash()).toBe(false);

    expect(location.hash).toBe('#something-else');
    expect(replaceState).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url, utf8Decode } from 'remote-lib-common';

import { browserWebAuthn, PASSKEY_CANCELLED_MESSAGE } from './webauthn';

describe('browserWebAuthn.registerPasskey', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('names the passkey for the app and its Relay; the account id is only its user handle', async () => {
    const create = vi.fn(async () => ({
      id: 'cred',
      response: {
        getPublicKey: () => new Uint8Array([1, 2, 3]).buffer,
        clientDataJSON: new Uint8Array([4]).buffer,
      },
    }));
    vi.stubGlobal('navigator', { credentials: { create } });

    await browserWebAuthn.registerPasskey(toBase64Url(new Uint8Array(32)), 'relay.dormouse.sh', 'user-123');

    const { user } = (create.mock.calls[0] as unknown as [{ publicKey: PublicKeyCredentialCreationOptions }])[0]
      .publicKey;
    expect(user.name).toBe('Dormouse Pocket (relay.dormouse.sh)');
    expect(user.displayName).toBe('Dormouse Pocket (relay.dormouse.sh)');
    expect(utf8Decode(new Uint8Array(user.id as ArrayBuffer))).toBe('user-123');
  });
});

describe('a dismissed or timed-out passkey prompt', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  // The browser's own message for it is a spec URL on Chromium.
  const dismissed = () => Promise.reject(new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError'));

  it('reads as one fixed sentence on sign-in, connect, and setup alike', async () => {
    vi.stubGlobal('navigator', { credentials: { get: dismissed, create: dismissed } });
    const challenge = toBase64Url(new Uint8Array(32));
    const messageOf = (attempt: Promise<unknown>) => attempt.then(() => null, (error: Error) => error.message);
    expect(await messageOf(browserWebAuthn.getAssertion(challenge, 'relay.dormouse.sh'))).toBe(PASSKEY_CANCELLED_MESSAGE);
    expect(await messageOf(browserWebAuthn.registerPasskey(challenge, 'relay.dormouse.sh', 'user-123'))).toBe(
      PASSKEY_CANCELLED_MESSAGE,
    );
  });

  it('leaves any other refusal as it was', async () => {
    const taken = new DOMException('already registered', 'InvalidStateError');
    vi.stubGlobal('navigator', { credentials: { create: () => Promise.reject(taken) } });
    await expect(
      browserWebAuthn.registerPasskey(toBase64Url(new Uint8Array(32)), 'relay.dormouse.sh', 'user-123'),
    ).rejects.toBe(taken);
  });
});

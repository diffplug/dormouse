import { afterEach, describe, expect, it, vi } from 'vitest';
import { toBase64Url, utf8Decode } from 'remote-lib-common';

import { browserWebAuthn } from './webauthn';

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

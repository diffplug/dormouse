/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { PairingRequest } from 'server-lib-common';

import { RemotePairingModal } from './RemotePairingModal';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const REQUEST: PairingRequest = {
  accountId: 'ned@example.com',
  passkeyCredentialId: 'cred-abc123',
  passkeyPublicKeyHash: 'ph_9f2c1a77',
  devicePublicKey: 'abcd1234ef567890deadbeefcafef00d',
  requestedLabel: 'Ned’s iPhone',
};

let container: HTMLDivElement;
let root: Root;

async function render(verified?: boolean) {
  await act(async () => {
    root.render(
      <RemotePairingModal
        request={REQUEST}
        verified={verified}
        onApprove={() => {}}
        onDeny={() => {}}
      />,
    );
  });
}

function text(): string {
  return container.textContent ?? '';
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
});

describe('RemotePairingModal', () => {
  it('asks the user to vouch for the request when nothing verified it', async () => {
    await render();
    expect(text()).toContain('Approve only if you are the one asking');
    expect(text()).not.toContain('scanned the setup code');
    // The fingerprint is the control on this path, so it has to be rendered.
    expect(text()).toContain('cd1234ef…');
  });

  it('says what proved the device when the pairing is verified', async () => {
    await render(true);
    // Displaying the code was the local-presence act, so the copy names that
    // rather than asking for a comparison the user has no second copy of.
    expect(text()).toContain('scanned the setup code shown on this machine');
    expect(text()).not.toContain('Approve only if you are the one asking');
    // The key stays as secondary identity, but nothing asks for a compare.
    expect(text()).toContain('cd1234ef…');
    expect(text()).not.toMatch(/compare|match(es)? the/i);
  });

  it('offers exactly one confirm either way', async () => {
    for (const verified of [false, true]) {
      await render(verified);
      const buttons = [...container.querySelectorAll('button')].map((b) => b.textContent?.trim());
      expect(buttons).toEqual(['Deny', 'Approve']);
    }
  });
});

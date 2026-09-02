/**
 * The DOM harness the Pocket screen suites share (`App.push.test.tsx`,
 * `App.scan.test.tsx`, `App.test.tsx`, `ScanInvitation.test.tsx`), the way
 * `components/wall/wall-test-utils.ts` shares the wall's. Each file keeps its
 * own `vi.mock` factories — those are hoisted above imports and cannot reach a
 * binding from here — and its own render helper, which is the part that differs.
 */

import { act } from 'react';
import {
  formatPairingInvitationUrl,
  generateNoiseKeyPair,
  randomBase64Url,
  toBase64Url,
  type PairingInvitation,
} from 'server-lib-common';

import { PAIRING_CODE_LABEL, type HostView } from './App';
import { testRoutingId } from '../test-e2e-client';

/** A live invitation URL, composed by the emitter a Host actually uses. */
export async function invitationUrl(
  origin: string,
): Promise<{ url: string; invitation: PairingInvitation }> {
  const keyPair = await generateNoiseKeyPair();
  const invitation: PairingInvitation = {
    hostId: testRoutingId(),
    inviteId: testRoutingId(),
    expiry: Math.floor(Date.now() / 1000) + 300,
    setupToken: randomBase64Url(32),
    ephPub: keyPair.publicKey,
    ephPubBase64Url: toBase64Url(keyPair.publicKey),
  };
  return { url: formatPairingInvitationUrl(origin, invitation), invitation };
}

/** The two Hosts every suite lists, named so an assertion says which one. */
export const HOSTS: HostView[] = [
  { hostId: 'host-1', label: 'First laptop', online: true, needsPairing: false },
  { hostId: 'host-2', label: 'Second laptop', online: true, needsPairing: false },
];

/** Let every pending promise chain land and React commit what they produced. */
export async function settle(): Promise<void> {
  for (let pass = 0; pass < 3; pass++) {
    await act(async () => {
      for (let tick = 0; tick < 12; tick++) await Promise.resolve();
    });
  }
}

export function buttonNamed(
  container: HTMLElement,
  label: string | RegExp,
): HTMLButtonElement | null {
  return (
    [...container.querySelectorAll('button')].find((b) =>
      typeof label === 'string' ? b.textContent === label : label.test(b.textContent ?? ''),
    ) ?? null
  );
}

export async function click(container: HTMLElement, label: string | RegExp): Promise<void> {
  act(() => buttonNamed(container, label)!.click());
  await settle();
}

export function alertText(container: HTMLElement): string | null {
  return container.querySelector('[role="alert"]')?.textContent ?? null;
}

/**
 * The two digits, off the live region that names them — the same anchor the
 * walkthrough harness uses (`scripts/pairing-walkthrough/steps.mjs`). Matching
 * the screen on its accessible name rather than on the sentence beside it is
 * what lets that sentence be rewritten without touching either.
 */
export function pairingCode(container: HTMLElement): string | null {
  return (
    container
      .querySelector(`[role="status"][aria-label="${PAIRING_CODE_LABEL}"]`)
      ?.textContent?.trim() ?? null
  );
}

/** One Host's row, found through its label so the assertions name a Host. */
export function rowFor(container: HTMLElement, label: string): HTMLElement {
  const title = [...container.querySelectorAll('div')].find((el) => el.textContent === label);
  const row = title?.closest('div.rounded-lg');
  if (!(row instanceof HTMLElement)) throw new Error(`no host row for ${label}`);
  return row;
}

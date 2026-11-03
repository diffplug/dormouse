/**
 * @vitest-environment jsdom
 *
 * What the paired-browser panel shows and when it may prompt
 * (`docs/specs/pocket-app.md` -> "Paired browsers"). The protocol under it is
 * `lib/src/remote/client/pocket-devices.test.ts`.
 */
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PairedBrowserV1 } from 'remote-lib-common';

import { DEVICES_UNSUPPORTED_MESSAGE, PasskeyUnavailableError, SessionExpiredError } from '../client/pocket-client';
import { alertText, buttonNamed, click, settle } from './app-test-utils';
import {
  CONFIRM_REVOKE_LABEL,
  PASSKEY_NOT_CONFIRMED,
  PairedBrowsers,
  RETRY_PAIRED_BROWSERS,
  REVOKE_LABEL,
  THIS_BROWSER,
  revokeConsequence,
  type PairedBrowsersSession,
} from './PairedBrowsers';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const MINE: PairedBrowserV1 = {
  id: 'aaaaaaaaaaaaaaaa',
  label: 'Dormouse Pocket (Home Screen)',
  approvedAt: 1,
  lastSeenAt: null,
  self: true,
};
const THEIRS: PairedBrowserV1 = {
  id: 'bbbbbbbbbbbbbbbb',
  label: 'Dormouse Pocket (browser)',
  approvedAt: 2,
  lastSeenAt: 3,
  self: false,
};

let container: HTMLDivElement;
let root: Root;
const session = {
  listDevices: vi.fn<PairedBrowsersSession['listDevices']>(),
  revokeDevice: vi.fn<PairedBrowsersSession['revokeDevice']>(),
};
const onSelfRevoked = vi.fn<() => void>();
const onAccountLost = vi.fn<(error: Error) => void>();

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  session.listDevices.mockReset().mockResolvedValue({ ok: true, devices: [MINE, THEIRS] });
  session.revokeDevice.mockReset().mockResolvedValue({ ok: true, self: false });
  onSelfRevoked.mockReset();
  onAccountLost.mockReset();
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

async function render(): Promise<void> {
  act(() =>
    root.render(
      <StrictMode>
        <PairedBrowsers session={session} onSelfRevoked={onSelfRevoked} onAccountLost={onAccountLost} />
      </StrictMode>,
    ),
  );
  await settle();
}

const revokeButton = (device: PairedBrowserV1) =>
  container.querySelector<HTMLButtonElement>(`button[aria-label="${REVOKE_LABEL} ${device.label} ${device.id}"]`)!;

async function askToRevoke(device: PairedBrowserV1): Promise<void> {
  act(() => revokeButton(device).click());
  await settle();
}

describe('PairedBrowsers', () => {
  it('lists on mount, once, under StrictMode too, since listing never prompts', async () => {
    await render();
    expect(session.listDevices).toHaveBeenCalledOnce();
    expect(buttonNamed(container, RETRY_PAIRED_BROWSERS)).toBeNull();
    expect(session.revokeDevice).not.toHaveBeenCalled();
  });

  it('shows each record with its id and marks only its own', async () => {
    await render();
    const rows = [...container.querySelectorAll('section > div')].map((row) => row.textContent ?? '');
    expect(rows).toHaveLength(2);
    expect(rows[0]).toContain(THIS_BROWSER);
    expect(rows[0]).toContain(MINE.id);
    expect(rows[0]).toContain('Not in the access log');
    expect(rows[1]).not.toContain(THIS_BROWSER);
    expect(rows[1]).toContain(THEIRS.id);
  });

  it('says a Burrow too old for the list is too old, never that it has no browsers', async () => {
    session.listDevices.mockResolvedValue({ ok: false, message: DEVICES_UNSUPPORTED_MESSAGE, unsupported: true });
    await render();
    expect(container.textContent).toContain(DEVICES_UNSUPPORTED_MESSAGE);
    expect(buttonNamed(container, RETRY_PAIRED_BROWSERS)).toBeNull();
  });

  it('offers to try again on a refusal', async () => {
    session.listDevices.mockResolvedValueOnce({ ok: false, message: 'refused', unsupported: false });
    await render();
    expect(alertText(container)).toBe('refused');

    await click(container, RETRY_PAIRED_BROWSERS);
    expect(container.textContent).toContain(THEIRS.id);
  });

  it('revokes only from its inline confirmation, then re-reads the list', async () => {
    await render();
    await askToRevoke(THEIRS);
    expect(session.revokeDevice).not.toHaveBeenCalled();
    expect(container.textContent).toContain(revokeConsequence(THEIRS));

    session.listDevices.mockResolvedValue({ ok: true, devices: [MINE] });
    await click(container, CONFIRM_REVOKE_LABEL);

    expect(session.revokeDevice).toHaveBeenCalledWith(THEIRS.id);
    expect(onSelfRevoked).not.toHaveBeenCalled();
    expect(session.listDevices).toHaveBeenCalledTimes(2);
    expect(container.textContent).not.toContain(THEIRS.id);
  });

  it('cancels with no request made', async () => {
    await render();
    await askToRevoke(THEIRS);
    await click(container, 'Cancel');
    expect(session.revokeDevice).not.toHaveBeenCalled();
    expect(container.textContent).not.toContain(CONFIRM_REVOKE_LABEL);
  });

  it('warns of its own session ending, and hands that revocation up rather than re-reading', async () => {
    session.revokeDevice.mockResolvedValue({ ok: true, self: true });
    await render();
    await askToRevoke(MINE);
    expect(container.textContent).toContain(revokeConsequence(MINE));

    await click(container, CONFIRM_REVOKE_LABEL);

    expect(onSelfRevoked).toHaveBeenCalledOnce();
    expect(session.listDevices).toHaveBeenCalledOnce();
  });

  it('reads a dismissed prompt in its own words, the confirmation still open', async () => {
    session.revokeDevice.mockRejectedValue(new DOMException('browser text', 'NotAllowedError'));
    await render();
    await askToRevoke(THEIRS);
    await click(container, CONFIRM_REVOKE_LABEL);

    expect(alertText(container)).toBe(PASSKEY_NOT_CONFIRMED);
    expect(buttonNamed(container, CONFIRM_REVOKE_LABEL)).not.toBeNull();
  });

  it('shows a Burrow’s refusal, the confirmation still open', async () => {
    session.revokeDevice.mockResolvedValue({ ok: false, message: 'not verified' });
    await render();
    await askToRevoke(THEIRS);
    await click(container, CONFIRM_REVOKE_LABEL);

    expect(alertText(container)).toBe('not verified');
    expect(session.listDevices).toHaveBeenCalledOnce();
  });

  it('hands up what only sign-in mends', async () => {
    for (const error of [new SessionExpiredError(), new PasskeyUnavailableError()]) {
      onAccountLost.mockReset();
      session.revokeDevice.mockRejectedValueOnce(error);
      await render();
      await askToRevoke(THEIRS);
      await click(container, CONFIRM_REVOKE_LABEL);
      expect(onAccountLost).toHaveBeenCalledWith(error);
      await click(container, 'Cancel');
    }
  });
});

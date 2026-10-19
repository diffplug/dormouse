/**
 * @vitest-environment jsdom
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPlatform, setPlatform } from '../lib/platform';
import { FakePtyAdapter } from '../lib/platform/fake-adapter';
import { MANAGED_VOICES } from '../lib/platform/managed-voice-types';
import { makeStubManagedVoicePort } from '../lib/platform/test-ports';
import {
  UNENROLLED_STATUS,
  enrolledStatus,
  makeStubBurrowLink,
  type PrimedBurrow,
} from '../host/remote/test-burrow-link';
import { DEFAULT_RELAY_ORIGIN } from '../host/relay-origin';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import { networkPolicyResult, nothingPolicy } from '../remote/network-policy';
import { HOSTED_PRICING_URL } from './HostedEnrollment';
import { MANAGED_VOICE_DISCLOSURE, ManagedVoiceSection, NO_PLAN_COPY } from './ManagedVoiceSection';
import { AlarmSettingsSection } from './SettingsDialog';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

/** A Hosted build's Burrow, enrolled with Hosted and connected. */
const ENROLLED: BurrowConsoleStatus = enrolledStatus({
  relayOrigin: DEFAULT_RELAY_ORIGIN,
  relayMode: 'hosted',
  accountOrigin: 'https://hosted.dormouse.sh',
});

/** Render with a managed-voice port and a Burrow service, recording every command it hears. */
async function render(
  primed: PrimedBurrow,
  voice = makeStubManagedVoicePort(true),
  onShowNetwork?: () => void,
) {
  const link = makeStubBurrowLink(primed);
  const command = vi.spyOn(link, 'command');
  const adapter = Object.assign(new FakePtyAdapter(), { managedVoice: voice, burrow: link });
  setPlatform(adapter);
  await act(async () => root.render(<ManagedVoiceSection onShowNetwork={onShowNetwork} />));
  await act(async () => {});
  return { command, voice };
}

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  // Unmounting drops the stores' last subscriber, which resets them.
  await act(async () => root.unmount());
  container.remove();
});

describe('ManagedVoiceSection', () => {
  it('renders nothing where the build has no managed voice', async () => {
    setPlatform(new FakePtyAdapter());
    await act(async () => root.render(<ManagedVoiceSection />));
    expect(container.innerHTML).toBe('');
  });

  it('states what leaves the machine, then enrolls with the suggested name, no paste field', async () => {
    const { command, voice } = await render({ status: UNENROLLED_STATUS }, makeStubManagedVoicePort(false));
    const begin = vi.spyOn(voice, 'beginEnrollment');
    expect(text()).toContain(MANAGED_VOICE_DISCLOSURE);
    expect(text()).toContain('though no limit is guaranteed');
    expect(container.querySelector('input')).toBeNull();

    await act(async () => button('Enable managed voice')!.click());
    expect(begin).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalledWith('beginHostedEnrollment', expect.anything());
  });

  it('under Nothing, explains and points at Network rather than enrolling', async () => {
    const onShowNetwork = vi.fn();
    const { command } = await render(
      { status: UNENROLLED_STATUS, network: networkPolicyResult(nothingPolicy(), 'hosted', []) },
      makeStubManagedVoicePort(false),
      onShowNetwork,
    );
    expect(text()).toContain('Choose Local networks or Anywhere in');
    expect(button('Enable managed voice')).toBeUndefined();
    await act(async () => button('Network')!.click());
    expect(onShowNetwork).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalledWith('beginHostedEnrollment', expect.anything());
  });

  it('enrolled, picks a voice from the curated set', async () => {
    const { voice } = await render({ status: ENROLLED });
    expect(text()).toContain('Managed voice is enabled.');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Managed voice"]')!;
    expect([...select.options].map((option) => option.value)).toEqual(MANAGED_VOICES.map((v) => v.id));
    const configure = vi.spyOn(voice, 'configure');
    await act(async () => {
      select.value = MANAGED_VOICES[2]!.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(configure).toHaveBeenCalledWith({ voiceId: MANAGED_VOICES[2]!.id });
  });

  it('uses voice entitlement independently of the relay socket', async () => {
    await render({ status: { ...ENROLLED, connection: 'not-entitled' } });
    expect(text()).not.toContain(NO_PLAN_COPY);
  });

  it('shows plans when speak refuses the voice entitlement', async () => {
    await render({ status: ENROLLED }, makeStubManagedVoicePort(true, true));
    expect(text()).toContain(NO_PLAN_COPY);
    const openExternal = vi.fn();
    Object.assign(getPlatform(), { openExternal });
    await act(async () => button('See Hosted plans')!.click());
    expect(openExternal).toHaveBeenCalledWith(HOSTED_PRICING_URL);
  });

  it('offers voice independently when remote control is already enrolled', async () => {
    await render({ status: ENROLLED }, makeStubManagedVoicePort(false));
    expect(button('Enable managed voice')).toBeDefined();
    expect(container.querySelector('select')).toBeNull();
  });

  it('disconnects voice after confirming without clearing remote control', async () => {
    const { command, voice } = await render({ status: ENROLLED });
    const disconnect = vi.spyOn(voice, 'disconnect');
    await act(async () => button('Disconnect')!.click());
    expect(text()).toContain('Alarms will use your system voice.');
    expect(command).not.toHaveBeenCalledWith('clearEnrollment');
    await act(async () => button('Disconnect')!.click());
    expect(disconnect).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalledWith('clearEnrollment');
  });
  it('keeps a failed voice disconnect visible and retryable without clearing remote control', async () => {
    const { voice, command } = await render({ status: ENROLLED });
    const original = voice.status()!;
    const disconnect = vi.spyOn(voice, 'disconnect').mockImplementation(async () => {
      vi.spyOn(voice, 'status').mockReturnValue({ ...original, configured: false, disconnectFailed: true });
      await voice.configure({ voiceId: original.voiceId }); // Broadcast the failed-clear status.
      return { ok: false, message: 'Could not clear the saved token.' };
    });
    await act(async () => button('Disconnect')!.click());
    await act(async () => button('Disconnect')!.click());
    expect(text()).toContain('Could not clear the saved token.');
    expect(button('Enable managed voice')).toBeUndefined();
    await act(async () => button('Retry disconnect')!.click());
    expect(disconnect).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalledWith('clearEnrollment');
  });

});

describe('the spoken-alarm copy', () => {
  it.each([
    ['no port', false, 'Get managed ElevenLabs voices.'],
    ['a Hosted build’s port', true, 'Uses managed voice when enabled below'],
  ])('with %s', async (_label, port, copy) => {
    const adapter = new FakePtyAdapter();
    setPlatform(port ? Object.assign(adapter, { managedVoice: makeStubManagedVoicePort(false) }) : adapter);
    await act(async () => root.render(<AlarmSettingsSection sink="speech" />));
    expect(text()).toContain(copy);
  });
});

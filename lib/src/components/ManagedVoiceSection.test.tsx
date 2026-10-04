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
import { HOSTED_PRICING_URL, SIGN_IN_LABEL } from './HostedSignIn';
import { MANAGED_VOICE_DISCLOSURE, ManagedVoiceSection, NO_PLAN_COPY } from './ManagedVoiceSection';
import { AlarmSettingsSection } from './SettingsDialog';
import { makeStubBurrowLink } from '../host/remote/test-burrow-link';
import { resetPushDevices } from '../lib/push-devices';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

let container: HTMLDivElement;
let root: Root;

const text = () => container.textContent ?? '';
const button = (label: string) =>
  [...container.querySelectorAll('button')].find((b) => b.textContent?.trim() === label);

/** A Hosted build signed in: the Burrow enrolled with Hosted and connected. */
const SIGNED_IN: BurrowConsoleStatus = enrolledStatus({
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
  resetPushDevices();
  container.remove();
});

describe('ManagedVoiceSection', () => {
  it('renders nothing where the build has no managed voice', async () => {
    setPlatform(new FakePtyAdapter());
    await act(async () => root.render(<ManagedVoiceSection />));
    expect(container.innerHTML).toBe('');
  });

  it('states what leaves the machine, then signs in with the suggested name, no paste field', async () => {
    const { command } = await render({ status: UNENROLLED_STATUS }, makeStubManagedVoicePort(false));
    expect(text()).toContain(MANAGED_VOICE_DISCLOSURE);
    expect(text()).toContain('no deletion time is guaranteed');
    expect(container.querySelector('input')).toBeNull();

    await act(async () => button(SIGN_IN_LABEL)!.click());
    expect(command).toHaveBeenCalledWith('beginHostedEnrollment', { label: UNENROLLED_STATUS.suggestedLabel });
  });

  it('under Nothing, explains and points at Network rather than signing in', async () => {
    const onShowNetwork = vi.fn();
    const { command } = await render(
      { status: UNENROLLED_STATUS, network: networkPolicyResult(nothingPolicy(), 'hosted', []) },
      makeStubManagedVoicePort(false),
      onShowNetwork,
    );
    expect(text()).toContain('Choose Local networks or Anywhere there to sign in.');
    expect(button(SIGN_IN_LABEL)).toBeUndefined();
    await act(async () => button('Network')!.click());
    expect(onShowNetwork).toHaveBeenCalledOnce();
    expect(command).not.toHaveBeenCalledWith('beginHostedEnrollment', expect.anything());
  });

  it('signed in, picks a voice from the curated set', async () => {
    const { voice } = await render({ status: SIGNED_IN });
    expect(text()).toContain('Signed in to Dormouse Hosted.');
    const select = container.querySelector<HTMLSelectElement>('select[aria-label="Managed voice"]')!;
    expect([...select.options].map((option) => option.value)).toEqual(MANAGED_VOICES.map((v) => v.id));
    const configure = vi.spyOn(voice, 'configure');
    await act(async () => {
      select.value = MANAGED_VOICES[2]!.id;
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(configure).toHaveBeenCalledWith({ voiceId: MANAGED_VOICES[2]!.id });
  });

  it.each([
    ['the relay socket', { status: { ...SIGNED_IN, connection: 'not-entitled' as const } }, false],
    ['speak', { status: SIGNED_IN }, true],
  ])('says the account has no plan when %s refuses it', async (_by, primed, notEntitled) => {
    await render(primed, makeStubManagedVoicePort(true, notEntitled));
    expect(text()).toContain(NO_PLAN_COPY);
    const openExternal = vi.fn();
    Object.assign(getPlatform(), { openExternal });
    await act(async () => button('See Hosted plans')!.click());
    expect(openExternal).toHaveBeenCalledWith(HOSTED_PRICING_URL);
  });

  it('asks a computer signed in before managed voice to sign in again', async () => {
    await render({ status: SIGNED_IN }, makeStubManagedVoicePort(false));
    expect(text()).toContain('Sign out and sign in again to use it.');
    expect(container.querySelector('select')).toBeNull();
  });

  it('signs out after confirming, which is the Burrow’s local Disconnect', async () => {
    const { command } = await render({ status: SIGNED_IN });
    expect(text()).toContain('Remove this computer at hosted.dormouse.sh');
    await act(async () => button('Sign out')!.click());
    expect(text()).toContain('Remote control signs out too');
    expect(command).not.toHaveBeenCalledWith('clearEnrollment');
    await act(async () => button('Sign out')!.click());
    expect(command).toHaveBeenCalledWith('clearEnrollment');
  });
});

describe('the spoken-alarm copy', () => {
  // No port is a build with no Hosted mode (self-host, VS Code, the website),
  // which never links Hosted.
  it.each([
    ['no port', false, 'Uses your browser or system voice.', 'Hosted'],
    ['a Hosted build’s port', true, 'Uses managed voice while this computer is signed in to Dormouse Hosted', 'Get managed'],
  ])('with %s', async (_label, port, copy, absent) => {
    const adapter = new FakePtyAdapter();
    setPlatform(port ? Object.assign(adapter, { managedVoice: makeStubManagedVoicePort(false) }) : adapter);
    await act(async () => root.render(<AlarmSettingsSection sink="speech" />));
    expect(text()).toContain(copy);
    expect(text()).not.toContain(absent);
  });
});

describe('the push group\'s Hosted offer', () => {
  const OFFER = 'Get Pocket on your phone with Dormouse Hosted.';

  it.each([
    ['a Hosted build\'s non-member, not enrolled', { managed: true, configured: false, preview: false }, true],
    ['a member', { managed: true, configured: true, preview: false }, false],
    ['a build with no Hosted mode', { managed: false, configured: false, preview: false }, false],
    ['the inert preview, whose live line carries it', { managed: true, configured: false, preview: true }, false],
  ])('for %s', async (_label, { managed, configured, preview }, offered) => {
    stored.token = configured ? TOKEN : null;
    const adapter = Object.assign(new FakePtyAdapter(), {
      burrow: makeStubBurrowLink({}),
      ...(managed ? { managedVoice: makePort(false) } : {}),
    });
    setPlatform(adapter);
    await act(async () => root.render(<AlarmSettingsSection sink="push" preview={preview} />));
    expect(text().includes(OFFER)).toBe(offered);
  });
});

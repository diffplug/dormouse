import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./platform', () => ({ getPlatform: vi.fn() }));
vi.mock('../remote/burrow/network-policy-store', () => ({ getNetworkPolicySnapshot: vi.fn() }));

import { getPlatform } from './platform';
import { getNetworkPolicySnapshot } from '../remote/burrow/network-policy-store';
import {
  ALARM_UPSELL_SHOWN_AT_KEY,
  alarmUpsellShownToday,
  choosePushUpsell,
  chooseVoiceUpsell,
  STATUS_READ_MS,
  takeAlarmUpsell,
} from './alarm-upsell';
import { installLocalStorageStub } from './test-local-storage';
import { makeStubManagedVoicePort } from './platform/test-ports';
import type { PlatformAdapter } from './platform/types';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import type { ManagedVoiceStatus } from './platform/managed-voice-types';
import {
  enrolledStatus,
  makeStubBurrowLink,
  networkOn,
  SELF_HOST_UNENROLLED_STATUS,
  UNENROLLED_STATUS,
} from '../host/remote/test-burrow-link';
import { networkPolicyResult, nothingPolicy } from '../remote/network-policy';

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_800_000_000_000;
const voice = (over: Partial<ManagedVoiceStatus>): ManagedVoiceStatus =>
  ({ configured: false, voiceId: 'v', notEntitled: false, ...over });
const hosted = (over: Partial<BurrowConsoleStatus>): BurrowConsoleStatus =>
  ({ ...UNENROLLED_STATUS, enrolled: true, connection: 'connected', ...over });

describe('chooseVoiceUpsell', () => {
  it('points at turning managed voice on, or at the policy under Nothing', () => {
    expect(chooseVoiceUpsell(voice({}), false)).toBe('voice-turn-on');
    expect(chooseVoiceUpsell(voice({}), true)).toBe('voice-network');
  });

  it('points an account with no plan at the plans, whatever the policy', () => {
    expect(chooseVoiceUpsell(voice({ configured: true, notEntitled: true }), false)).toBe('voice-plans');
    expect(chooseVoiceUpsell(voice({ configured: true, notEntitled: true }), true)).toBe('voice-plans');
  });

  it('offers nothing without a port’s answer, to a member, or over an approval under way', () => {
    expect(chooseVoiceUpsell(null, false)).toBeNull();
    expect(chooseVoiceUpsell(voice({ configured: true }), false)).toBeNull();
    expect(chooseVoiceUpsell(voice({ enrollment: { status: 'waiting' } as ManagedVoiceStatus['enrollment'] }), false)).toBeNull();
    expect(chooseVoiceUpsell(voice({ enrollment: { status: 'redeeming' } as ManagedVoiceStatus['enrollment'] }), false)).toBeNull();
  });
});

describe('choosePushUpsell', () => {
  it('points a Hosted build not enrolled, or removed, at the Hosted Relay, or at the policy under Nothing', () => {
    expect(choosePushUpsell(UNENROLLED_STATUS, false)).toBe('push-hosted-relay');
    expect(choosePushUpsell(hosted({ connection: 'removed' }), false)).toBe('push-hosted-relay');
    expect(choosePushUpsell(UNENROLLED_STATUS, true)).toBe('push-network');
  });

  it('points an account with no plan at the plans', () => {
    expect(choosePushUpsell(hosted({ connection: 'not-entitled' }), false)).toBe('push-plans');
  });

  it('points a build without Hosted mode at setting up a phone, never at Hosted', () => {
    expect(choosePushUpsell(SELF_HOST_UNENROLLED_STATUS, false)).toBe('push-set-up-phone');
    expect(choosePushUpsell(SELF_HOST_UNENROLLED_STATUS, true)).toBe('push-set-up-phone');
    expect(choosePushUpsell(enrolledStatus({ connection: 'not-entitled' }), false)).toBeNull();
  });

  it('offers nothing without an answer, or to an enrolled member', () => {
    expect(choosePushUpsell(null, false)).toBeNull();
    expect(choosePushUpsell(hosted({}), false)).toBeNull();
    expect(choosePushUpsell(enrolledStatus(), false)).toBeNull();
  });
});

describe('alarmUpsellShownToday', () => {
  beforeEach(() => installLocalStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  it('holds for a day after a showing', () => {
    expect(alarmUpsellShownToday(NOW)).toBe(false);
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, String(NOW));
    expect(alarmUpsellShownToday(NOW + DAY - 1)).toBe(true);
    expect(alarmUpsellShownToday(NOW + DAY)).toBe(false);
  });

  it('counts a clock set back past the last showing as a new day', () => {
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, String(NOW));
    expect(alarmUpsellShownToday(NOW - 1000)).toBe(false);
  });

  it('has not shown when storage cannot be read, or holds a malformed record', () => {
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, '"soon"');
    expect(alarmUpsellShownToday(NOW)).toBe(false);
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => {},
    });
    expect(alarmUpsellShownToday(NOW)).toBe(false);
  });
});

describe('takeAlarmUpsell', () => {
  const statusRead = vi.fn();
  /** A Hosted desktop build: a Burrow service answering `status`, and a managed-voice port. */
  function build({ status = UNENROLLED_STATUS, port = true, nothing = false, policy = 'ready' } = {}) {
    const link = makeStubBurrowLink({ status });
    const command = link.command;
    link.command = (cmd, params) => {
      if (cmd === 'status') statusRead();
      return command(cmd, params);
    };
    vi.mocked(getPlatform).mockReturnValue({
      burrow: link,
      managedVoice: port ? makeStubManagedVoicePort(false) : undefined,
    } as unknown as PlatformAdapter);
    vi.mocked(getNetworkPolicySnapshot).mockReturnValue(
      policy === 'ready'
        ? { kind: 'ready', network: nothing ? networkPolicyResult(nothingPolicy(), status.relayMode, []) : networkOn(status.relayMode) }
        : { kind: 'loading' },
    );
  }
  const shown = () => true;
  const spent = () => localStorage.getItem(ALARM_UPSELL_SHOWN_AT_KEY);

  beforeEach(() => {
    installLocalStorageStub();
    statusRead.mockReset();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it('spends the day only on a line that shows', async () => {
    build();
    expect(await takeAlarmUpsell('speech', () => false, NOW)).toBeNull();
    expect(spent()).toBeNull();
    expect(await takeAlarmUpsell('speech', shown, NOW)).toBe('voice-turn-on');
    expect(spent()).toBe(String(NOW));
    // Once a day, across both sinks.
    expect(await takeAlarmUpsell('push', shown, NOW + 1)).toBeNull();
    expect(await takeAlarmUpsell('push', shown, NOW + DAY)).toBe('push-hosted-relay');
  });

  it('offers under Nothing, pointing at the policy', async () => {
    build({ nothing: true });
    expect(await takeAlarmUpsell('push', shown, NOW)).toBe('push-network');
  });

  it('asks the Burrow nothing before the policy answers, once the day is spent, or for speech', async () => {
    build({ policy: 'loading' });
    expect(await takeAlarmUpsell('push', shown, NOW)).toBeNull();
    build();
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, String(NOW));
    expect(await takeAlarmUpsell('push', shown, NOW)).toBeNull();
    localStorage.clear();
    expect(await takeAlarmUpsell('speech', shown, NOW)).toBe('voice-turn-on');
    expect(statusRead).not.toHaveBeenCalled();
    expect(await takeAlarmUpsell('push', shown, NOW + DAY)).toBe('push-hosted-relay');
    expect(statusRead).toHaveBeenCalledOnce();
  });

  it('offers no voice in a build without the port, and nothing to an entitled member', async () => {
    build({ status: SELF_HOST_UNENROLLED_STATUS, port: false });
    expect(await takeAlarmUpsell('speech', shown, NOW)).toBeNull();
    build({ status: hosted({}) });
    expect(await takeAlarmUpsell('push', shown, NOW)).toBeNull();
    expect(spent()).toBeNull();
  });

  it('gives up on a status read that outlives the preview', async () => {
    vi.useFakeTimers();
    vi.mocked(getPlatform).mockReturnValue({
      burrow: { ...makeStubBurrowLink({}), command: () => new Promise(() => {}) },
    } as unknown as PlatformAdapter);
    vi.mocked(getNetworkPolicySnapshot).mockReturnValue({ kind: 'ready', network: networkOn('hosted') });
    const taken = takeAlarmUpsell('push', shown, NOW);
    await vi.advanceTimersByTimeAsync(STATUS_READ_MS);
    expect(await taken).toBeNull();
    expect(spent()).toBeNull();
  });
});

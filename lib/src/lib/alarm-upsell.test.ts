import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALARM_UPSELL_SHOWN_AT_KEY,
  chooseAlarmUpsell,
  alarmUpsellShownToday,
  networkOffOrUnknown,
  type AlarmUpsellFacts,
} from './alarm-upsell';
import { installLocalStorageStub } from './test-local-storage';
import { hostedPricingUrl, HOSTED_REFS } from './hosted-links';
import { networkOn } from '../host/remote/test-burrow-link';
import { networkPolicyResult, nothingPolicy } from '../remote/network-policy';

const facts = (overrides: Partial<AlarmUpsellFacts>): AlarmUpsellFacts => ({
  sink: 'speech',
  membership: 'signed-out',
  managedVoice: true,
  networkOff: false,
  enrolled: false,
  ...overrides,
});

describe('chooseAlarmUpsell', () => {
  it('points speech at signing in, or at the plans, only where managed voice can play', () => {
    expect(chooseAlarmUpsell(facts({}))).toBe('sign-in-voice');
    expect(chooseAlarmUpsell(facts({ membership: 'no-plan' }))).toBe('plans-voice');
    // Any build whose adapter has no managed-voice port, a self-host one included.
    expect(chooseAlarmUpsell(facts({ managedVoice: false }))).toBeNull();
    expect(chooseAlarmUpsell(facts({ membership: 'unavailable' }))).toBeNull();
  });

  it.each(['speech', 'push'] as const)('never offers %s to a member, or under Nothing or before the policy answers', (sink) => {
    expect(chooseAlarmUpsell(facts({ sink, membership: 'member' }))).toBeNull();
    expect(chooseAlarmUpsell(facts({ sink, networkOff: true }))).toBeNull();
  });

  it('points push at signing in when signed out, and at the plans when the plan lapsed', () => {
    const push = (overrides: Partial<AlarmUpsellFacts>) => chooseAlarmUpsell(facts({ sink: 'push', ...overrides }));
    expect(push({})).toBe('sign-in-push');
    // Push needs no managed-voice port: Remote control signs in anywhere.
    expect(push({ managedVoice: false })).toBe('sign-in-push');
    // Removed from the account: enrolled still, and signing in again is the fix.
    expect(push({ enrolled: true })).toBe('sign-in-push');
    expect(push({ membership: 'no-plan', enrolled: true })).toBe('plans-push');
    // A build without Hosted mode: the Relay it has, only while not enrolled.
    expect(push({ membership: 'unavailable' })).toBe('set-up-phone');
    expect(push({ membership: 'unavailable', enrolled: true })).toBeNull();
    // No Burrow service (the website), or no answer: nowhere to set one up.
    expect(push({ membership: 'unavailable', enrolled: null })).toBeNull();
  });
});

describe('alarmUpsellShownToday', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;

  beforeEach(() => installLocalStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  it('holds for a day after a showing', () => {
    expect(alarmUpsellShownToday(now)).toBe(false);
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, String(now));
    expect(alarmUpsellShownToday(now + DAY - 1)).toBe(true);
    expect(alarmUpsellShownToday(now + DAY)).toBe(false);
  });

  it('treats a clock set back past the last showing as a new day', () => {
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, String(now));
    expect(alarmUpsellShownToday(now - 1000)).toBe(false);
  });

  it('has not shown when storage cannot be read, or holds a malformed record', () => {
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, 'soon');
    expect(alarmUpsellShownToday(now)).toBe(false);
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => {},
    });
    expect(alarmUpsellShownToday(now)).toBe(false);
  });
});

describe('networkOffOrUnknown', () => {
  it('holds every offer until a Burrow service has answered, and under Nothing', () => {
    expect(networkOffOrUnknown({ kind: 'unsupported' })).toBe(false);
    expect(networkOffOrUnknown({ kind: 'loading' })).toBe(true);
    expect(networkOffOrUnknown({ kind: 'error', message: 'x' })).toBe(true);
    expect(networkOffOrUnknown({ kind: 'ready', network: networkOn('hosted') })).toBe(false);
    expect(networkOffOrUnknown({ kind: 'ready', network: networkPolicyResult(nothingPolicy(), 'hosted', []) })).toBe(true);
  });
});

describe('hostedPricingUrl', () => {
  it('puts the ref ahead of the section', () => {
    expect(hostedPricingUrl(HOSTED_REFS.upsellVoice)).toBe('https://dormouse.sh/hosted/?ref=upsell-voice#pricing');
    expect(hostedPricingUrl(HOSTED_REFS.settingsPush)).toBe('https://dormouse.sh/hosted/?ref=settings-push#pricing');
  });
});

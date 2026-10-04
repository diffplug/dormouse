import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALARM_UPSELL_SHOWN_AT_KEY,
  chooseAlarmUpsell,
  claimAlarmUpsell,
  networkOffOrUnknown,
  takeAlarmUpsell,
  type AlarmUpsellFacts,
} from './alarm-upsell';
import { installLocalStorageStub } from './test-local-storage';
import { hostedPageUrl, HOSTED_REFS } from './hosted-links';
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
    // VS Code until it plays managed voice, and a self-host build.
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
    // VS Code signs in through Remote control: no managed voice needed.
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

describe('claimAlarmUpsell', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;

  beforeEach(() => installLocalStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  it('allows one a day, across both toggles', () => {
    expect(takeAlarmUpsell(true, facts({}), now)).toBe('sign-in-voice');
    expect(takeAlarmUpsell(true, facts({ sink: 'push' }), now + 1000)).toBeNull();
    expect(takeAlarmUpsell(true, facts({}), now + DAY - 1)).toBeNull();
    expect(takeAlarmUpsell(true, facts({ sink: 'push' }), now + DAY)).toBe('sign-in-push');
  });

  it('spends nothing on turning off, or when no line is earned', () => {
    expect(takeAlarmUpsell(false, facts({}), now)).toBeNull();
    expect(takeAlarmUpsell(true, facts({ membership: 'member' }), now)).toBeNull();
    expect(localStorage.getItem(ALARM_UPSELL_SHOWN_AT_KEY)).toBeNull();
    expect(takeAlarmUpsell(true, facts({}), now)).toBe('sign-in-voice');
  });

  it('treats a clock set back past the last showing as a new day', () => {
    expect(claimAlarmUpsell(now)).toBe(true);
    expect(claimAlarmUpsell(now - 1000)).toBe(true);
  });

  it('shows when storage cannot be read or written', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => { throw new Error('blocked'); },
      setItem: () => { throw new Error('blocked'); },
      removeItem: () => {},
    });
    expect(claimAlarmUpsell(now)).toBe(true);
    expect(claimAlarmUpsell(now)).toBe(true);
  });

  it('shows over a malformed record', () => {
    localStorage.setItem(ALARM_UPSELL_SHOWN_AT_KEY, 'soon');
    expect(claimAlarmUpsell(now)).toBe(true);
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

describe('hostedPageUrl', () => {
  it('puts the ref ahead of the section', () => {
    expect(hostedPageUrl('pricing', HOSTED_REFS.upsellVoice)).toBe('https://dormouse.sh/hosted/?ref=upsell-voice#pricing');
    expect(hostedPageUrl('pricing')).toBe('https://dormouse.sh/hosted/#pricing');
  });
});

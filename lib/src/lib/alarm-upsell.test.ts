import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALARM_UPSELL_SHOWN_AT_KEY,
  chooseAlarmUpsell,
  claimAlarmUpsell,
  takeAlarmUpsell,
  type AlarmUpsellFacts,
} from './alarm-upsell';
import { installLocalStorageStub } from './test-local-storage';
import { hostedPageUrl, HOSTED_REFS } from './hosted-links';

const NO_BURROW = { status: 'no-burrow', devices: [] } as const;
const NO_PHONE = { status: 'ready', devices: [] } as const;
const A_PHONE = { status: 'ready', devices: [{ label: 'iPhone' }] } as const;

const facts = (overrides: Partial<AlarmUpsellFacts>): AlarmUpsellFacts => ({
  sink: 'speech',
  membership: 'not-member',
  networkOff: false,
  push: NO_BURROW,
  hasBurrowService: true,
  ...overrides,
});

describe('chooseAlarmUpsell', () => {
  it('offers managed voice only to a Hosted build\'s non-member', () => {
    expect(chooseAlarmUpsell(facts({}))).toBe('hosted-voice');
    expect(chooseAlarmUpsell(facts({ membership: 'member' }))).toBeNull();
    // A self-host build, or one with no Hosted mode.
    expect(chooseAlarmUpsell(facts({ membership: 'unavailable' }))).toBeNull();
  });

  it.each(['speech', 'push'] as const)('offers nothing for %s turned off or under Nothing', (sink) => {
    expect(takeAlarmUpsell(false, facts({ sink }))).toBeNull();
    expect(chooseAlarmUpsell(facts({ sink, networkOff: true }))).toBeNull();
  });

  it('offers Hosted push only when no Burrow is enrolled, to a non-member', () => {
    const push = (overrides: Partial<AlarmUpsellFacts>) => chooseAlarmUpsell(facts({ sink: 'push', ...overrides }));
    expect(push({})).toBe('hosted-push');
    // Self-host, no Hosted mode, or a member: the Relay it has.
    expect(push({ membership: 'unavailable' })).toBe('set-up-phone');
    expect(push({ membership: 'member' })).toBe('set-up-phone');
    // Enrolled, so on a Relay already: only the phone is missing.
    expect(push({ push: NO_PHONE })).toBe('set-up-phone');
    expect(push({ push: A_PHONE })).toBeNull();
    expect(push({ push: { status: 'loading', devices: [] } })).toBeNull();
    expect(push({ push: { status: 'error', devices: [] } })).toBeNull();
    // No Burrow service (the website): nowhere to set one up.
    expect(push({ hasBurrowService: false })).toBeNull();
  });
});

describe('claimAlarmUpsell', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const now = 1_800_000_000_000;

  beforeEach(() => installLocalStorageStub());
  afterEach(() => vi.unstubAllGlobals());

  it('allows one a day, across both toggles', () => {
    expect(takeAlarmUpsell(true, facts({}), now)).toBe('hosted-voice');
    expect(takeAlarmUpsell(true, facts({ sink: 'push' }), now + 1000)).toBeNull();
    expect(takeAlarmUpsell(true, facts({}), now + DAY - 1)).toBeNull();
    expect(takeAlarmUpsell(true, facts({ sink: 'push' }), now + DAY)).toBe('hosted-push');
  });

  it('spends nothing when no line is earned', () => {
    expect(takeAlarmUpsell(false, facts({}), now)).toBeNull();
    expect(localStorage.getItem(ALARM_UPSELL_SHOWN_AT_KEY)).toBeNull();
    expect(takeAlarmUpsell(true, facts({}), now)).toBe('hosted-voice');
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

describe('hostedPageUrl', () => {
  it('puts the ref ahead of the section', () => {
    expect(hostedPageUrl('voice', HOSTED_REFS.upsellVoice)).toBe('https://dormouse.sh/hosted/?ref=upsell-voice#voice');
    expect(hostedPageUrl('remote-control')).toBe('https://dormouse.sh/hosted/#remote-control');
  });
});

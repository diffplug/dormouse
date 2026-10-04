import type { AlertSink } from './alert-delivery-model';
import type { HostedMembership } from './hosted-membership';
import { getStorage } from './local-json-store';
import type { PushDevicesState } from './push-devices';

/**
 * The one extra line a Baseboard alarm toggle's preview may carry
 * (`docs/specs/alert.md` -> "Settings dialog"):
 *
 * - `hosted-voice`: spoken alarms could use a managed voice;
 * - `hosted-push`: push has no Burrow to send from, and Hosted would be one;
 * - `set-up-phone`: push has nowhere to go, and the fix is in Settings → Network.
 */
export type AlarmUpsell = 'hosted-voice' | 'hosted-push' | 'set-up-phone';

export interface AlarmUpsellFacts {
  sink: AlertSink;
  /** The toggle turned its sink on. */
  turnedOn: boolean;
  membership: HostedMembership;
  /** The network policy is Nothing, which sends no push and asks for no voice. */
  networkOff: boolean;
  /** The push-device list as the preview shows it, never refreshed for it. */
  push: PushDevicesState;
  /** A Burrow service is behind this webview, so Settings → Network can add a phone. */
  hasBurrowService: boolean;
}

/** Which line this toggle earns, before the daily limit. */
export function chooseAlarmUpsell(facts: AlarmUpsellFacts): AlarmUpsell | null {
  if (!facts.turnedOn || facts.networkOff) return null;
  if (facts.sink === 'speech') return facts.membership === 'not-member' ? 'hosted-voice' : null;
  if (!facts.hasBurrowService) return null;
  const { status, devices } = facts.push;
  // Not enrolled: a Hosted build's non-member is offered Hosted's Relay; every
  // other build, and a member, is pointed at enrolling with the Relay it has.
  if (status === 'no-burrow') return facts.membership === 'not-member' ? 'hosted-push' : 'set-up-phone';
  // Enrolled, so already on a Relay: what is missing is the phone.
  if (status === 'ready' && devices.length === 0) return 'set-up-phone';
  return null;
}

/** When a line last showed, on this machine (every window shares the origin). */
export const ALARM_UPSELL_SHOWN_AT_KEY = 'dormouse:alarm-upsell-shown-at';
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Whether a line may show now, recording that it did. At most one a day across
 * both toggles; storage that cannot be read or written only means it shows.
 */
export function claimAlarmUpsell(now: number = Date.now()): boolean {
  try {
    const last = Number(getStorage()?.getItem(ALARM_UPSELL_SHOWN_AT_KEY));
    // A clock set back past the last showing counts as a new day.
    if (last > 0 && now >= last && now - last < DAY_MS) return false;
  } catch {
    // Unreadable: show it.
  }
  try {
    getStorage()?.setItem(ALARM_UPSELL_SHOWN_AT_KEY, String(now));
  } catch {
    // Unwritable: it may show again sooner.
  }
  return true;
}

/** The line for this toggle, if it earns one and today's has not shown. */
export function takeAlarmUpsell(facts: AlarmUpsellFacts, now?: number): AlarmUpsell | null {
  const upsell = chooseAlarmUpsell(facts);
  return upsell && claimAlarmUpsell(now) ? upsell : null;
}

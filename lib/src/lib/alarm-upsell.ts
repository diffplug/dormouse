import type { AlertSink } from './alert-delivery-model';
import { getHostedMembership, type HostedMembership } from './hosted-membership';
import { loadJson, saveJson } from './local-json-store';
import { getPushDevices, type PushDevicesState } from './push-devices';
import { burrowLink } from '../remote/burrow/burrow-status-store';
import { getNetworkPolicySnapshot, policyOf, type NetworkPolicyStoreState } from '../remote/burrow/network-policy-store';

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
  membership: HostedMembership;
  /**
   * The network policy is Nothing, which sends no push and asks for no voice,
   * or a Burrow service has not said yet which policy it is.
   */
  networkOff: boolean;
  /** The push-device list as the preview shows it, never refreshed for it. */
  push: PushDevicesState;
  /** A Burrow service is behind this webview, so Settings → Network can add a phone. */
  hasBurrowService: boolean;
}

/** Which offer a sink earns, before the daily limit; the Settings dialog's Hosted links read it too. */
export function chooseAlarmUpsell(facts: AlarmUpsellFacts): AlarmUpsell | null {
  if (facts.networkOff) return null;
  if (facts.sink === 'speech') return facts.membership === 'not-member' ? 'hosted-voice' : null;
  if (!facts.hasBurrowService) return null;
  // Not enrolled: a Hosted build's non-member is offered Hosted's Relay; every
  // other build, and a member, is pointed at enrolling with the Relay it has.
  // Enrolled with no device is no offer: the device line already names the
  // fix, which may be a switch in Pocket on a phone already paired.
  if (facts.push.status !== 'no-burrow') return null;
  return facts.membership === 'not-member' ? 'hosted-push' : 'set-up-phone';
}

/** When a line last showed, on this machine (every window shares the origin). */
export const ALARM_UPSELL_SHOWN_AT_KEY = 'dormouse:alarm-upsell-shown-at';
const DAY_MS = 24 * 60 * 60 * 1000;
const isNumber = (value: unknown): value is number => typeof value === 'number';

/**
 * Whether a line may show now, recording that it did. At most one a day across
 * both toggles; storage that cannot be read or written only means it shows.
 */
export function claimAlarmUpsell(now: number = Date.now()): boolean {
  const last = loadJson(ALARM_UPSELL_SHOWN_AT_KEY, 0, isNumber);
  // A clock set back past the last showing counts as a new day.
  if (last > 0 && now >= last && now - last < DAY_MS) return false;
  saveJson(ALARM_UPSELL_SHOWN_AT_KEY, now);
  return true;
}

/** Nothing, or not answered yet by a Burrow service that will answer. */
export function networkOffOrUnknown(network: NetworkPolicyStoreState): boolean {
  if (network.kind === 'unsupported') return false;
  const policy = policyOf(network);
  return policy === null || policy.level === 'nothing';
}

/** The facts as the stores hold them now. */
export function currentAlarmUpsellFacts(sink: AlertSink): AlarmUpsellFacts {
  return {
    sink,
    membership: getHostedMembership(),
    networkOff: networkOffOrUnknown(getNetworkPolicySnapshot()),
    push: getPushDevices(),
    hasBurrowService: burrowLink() !== undefined,
  };
}

/** The line for a toggle, if it turned its sink on, earns one, and today's has not shown. */
export function takeAlarmUpsell(
  turnedOn: boolean,
  facts: AlarmUpsellFacts,
  now?: number,
): AlarmUpsell | null {
  const upsell = turnedOn ? chooseAlarmUpsell(facts) : null;
  return upsell && claimAlarmUpsell(now) ? upsell : null;
}

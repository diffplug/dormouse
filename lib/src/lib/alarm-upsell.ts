import type { AlertSink } from './alert-delivery-model';
import { membershipOf, readBurrowStanding, voiceStatus, type HostedMembership } from './hosted-membership';
import { loadJson, saveJson } from './local-json-store';
import { getPlatformOrNull } from './platform';
import { getNetworkPolicySnapshot, policyOf, type NetworkPolicyStoreState } from '../remote/burrow/network-policy-store';

/**
 * The one extra line a Baseboard alarm toggle's preview may carry
 * (`docs/specs/alert.md` -> "Settings dialog"):
 *
 * - `sign-in-voice` / `sign-in-push`: a Hosted build not signed in, pointed at
 *   signing in — in Notifications' managed voice, or Network's Remote control;
 * - `plans-voice` / `plans-push`: signed in with no plan, pointed at the plans;
 * - `set-up-phone`: push has no Burrow enrolled in a build without Hosted
 *   mode, pointed at Settings → Network.
 */
export type AlarmUpsell = 'sign-in-voice' | 'sign-in-push' | 'plans-voice' | 'plans-push' | 'set-up-phone';

export interface AlarmUpsellFacts {
  sink: AlertSink;
  membership: HostedMembership;
  /** This build can play managed voice: its adapter has a `managedVoice` port. */
  managedVoice: boolean;
  /**
   * The network policy is Nothing, which sends no push and asks for no voice,
   * or a Burrow service has not said yet which policy it is.
   */
  networkOff: boolean;
  /**
   * Whether this computer's Burrow is enrolled with a Relay, as its service
   * answers; `null` without a service (the website) or an answer.
   */
  enrolled: boolean | null;
}

/** Which offer a sink earns, before the daily limit. */
export function chooseAlarmUpsell(facts: AlarmUpsellFacts): AlarmUpsell | null {
  const { sink, membership } = facts;
  if (facts.networkOff || membership === 'member') return null;
  if (sink === 'speech') {
    if (!facts.managedVoice) return null;
    return membership === 'signed-out' ? 'sign-in-voice' : membership === 'no-plan' ? 'plans-voice' : null;
  }
  if (membership === 'no-plan') return 'plans-push';
  if (membership === 'signed-out') return 'sign-in-push';
  // Enrolled, push has a Relay, and the device line names what else is missing.
  return facts.enrolled === false ? 'set-up-phone' : null;
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

/** The facts now; the standing may take one read of the Burrow service. */
export async function currentAlarmUpsellFacts(sink: AlertSink): Promise<AlarmUpsellFacts> {
  const standing = await readBurrowStanding();
  return {
    sink,
    membership: membershipOf(standing, voiceStatus()),
    managedVoice: getPlatformOrNull()?.managedVoice !== undefined,
    networkOff: networkOffOrUnknown(getNetworkPolicySnapshot()),
    enrolled: standing?.enrolled ?? null,
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

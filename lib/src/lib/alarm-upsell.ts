import type { AlertSink } from './alert-delivery-model';
import { managedVoicePort, membershipOf, type HostedMembership } from './hosted-membership';
import { loadJson, saveJson } from './local-json-store';
import { readBurrowStatusOnce } from '../remote/burrow/burrow-status-store';

/**
 * The one extra line a Baseboard alarm toggle's preview may carry
 * (`docs/specs/alert.md` -> "Settings dialog"):
 *
 * - `sign-in-voice` / `sign-in-push`: a Hosted build not signed in, pointed at
 *   signing in — in Notifications' managed voice, or Network's Remote control;
 * - `plans-voice` / `plans-push`: signed in with no plan, pointed at the plans;
 * - `set-up-phone`: push has no Burrow enrolled in a build without Hosted
 *   mode, pointed at Settings → Network.
 *
 * The network policy does not gate it: the line is a link that makes no
 * request, and Nothing is most machines' install default rather than a
 * choice. Settings, where a signed-out line leads, explains the policy.
 */
export type AlarmUpsell = 'sign-in-voice' | 'sign-in-push' | 'plans-voice' | 'plans-push' | 'set-up-phone';

export interface AlarmUpsellFacts {
  sink: AlertSink;
  membership: HostedMembership;
  /** This build can play managed voice: its adapter has a `managedVoice` port. */
  managedVoice: boolean;
  /**
   * Whether this computer's Burrow is enrolled with a Relay, as its service
   * answers; `null` without a service (the website) or an answer.
   */
  enrolled: boolean | null;
}

/** Which offer a sink earns, before the daily limit. */
export function chooseAlarmUpsell(facts: AlarmUpsellFacts): AlarmUpsell | null {
  const { sink, membership } = facts;
  if (membership === 'member') return null;
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
/** Past the plain preview's life, so a later answer has no preview left to join. */
const STATUS_READ_MS = 2500;
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** Whether today's line has shown. Storage that cannot be read means it has not. */
export function alarmUpsellShownToday(now: number = Date.now()): boolean {
  const last = loadJson(ALARM_UPSELL_SHOWN_AT_KEY, 0, isNumber);
  // A clock set back past the last showing counts as a new day.
  return last > 0 && now >= last && now - last < DAY_MS;
}

/**
 * The line a toggle that turned `sink` on earns, if today's has not shown and
 * its preview is `stillShown` once decided, recording that it showed. The
 * cheap answers come first, so a toggle that can earn nothing never asks the
 * Burrow service where this machine stands.
 */
export async function takeAlarmUpsell(
  sink: AlertSink,
  stillShown: () => boolean = () => true,
  now: number = Date.now(),
): Promise<AlarmUpsell | null> {
  const port = managedVoicePort();
  if ((sink === 'speech' && !port) || alarmUpsellShownToday(now)) return null;
  // Bounded: an answer later than the preview's life is no use to it.
  const status = await Promise.race([
    readBurrowStatusOnce(),
    new Promise<null>((resolve) => setTimeout(() => resolve(null), STATUS_READ_MS)),
  ]);
  const upsell = chooseAlarmUpsell({
    sink,
    membership: membershipOf(status, port?.status() ?? null),
    managedVoice: port !== undefined,
    enrolled: status?.enrolled ?? null,
  });
  if (!upsell || !stillShown()) return null;
  saveJson(ALARM_UPSELL_SHOWN_AT_KEY, now);
  return upsell;
}

import type { AlertSink } from './alert-delivery-model';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import type { ManagedVoiceStatus } from './platform/managed-voice-types';
import { getPlatform } from './platform';
import { loadJson, saveJson } from './local-json-store';
import { getNetworkPolicySnapshot } from '../remote/burrow/network-policy-store';
import { readBurrowStatusOnce } from '../remote/burrow/burrow-status-store';

/**
 * The one live line a Baseboard alarm toggle's preview may carry
 * (`docs/specs/alert.md` -> "Settings dialog"). Each opens a Settings topic or
 * the Hosted plans; `-network` is its sink's offer under Nothing, which points
 * at the policy instead of at what Nothing blocks.
 *
 * - `voice-turn-on` / `voice-network`: managed voice is not turned on;
 * - `voice-plans` / `push-plans`: Hosted said the account has no plan;
 * - `push-hosted-relay` / `push-network`: a Hosted build not enrolled, or
 *   removed from its account;
 * - `push-set-up-phone`: a build without Hosted mode not enrolled with its Relay.
 */
export type AlarmUpsell =
  | 'voice-turn-on'
  | 'voice-network'
  | 'voice-plans'
  | 'push-hosted-relay'
  | 'push-network'
  | 'push-plans'
  | 'push-set-up-phone';

/**
 * Speech's offer, from managed voice's status: `null` without a port, which
 * only a Hosted build has, or before the host answers.
 */
export function chooseVoiceUpsell(voice: ManagedVoiceStatus | null, nothing: boolean): AlarmUpsell | null {
  if (!voice) return null;
  if (voice.configured) return voice.notEntitled ? 'voice-plans' : null;
  // An approval under way is already the user's next step.
  if (voice.enrollment?.status === 'waiting' || voice.enrollment?.status === 'redeeming') return null;
  return nothing ? 'voice-network' : 'voice-turn-on';
}

/** Push's offer, from the Burrow's status: `null` without a service or an answer. */
export function choosePushUpsell(
  status: Pick<BurrowConsoleStatus, 'relayMode' | 'enrolled' | 'connection'> | null,
  nothing: boolean,
): AlarmUpsell | null {
  if (!status) return null;
  // Never Hosted in a build without Hosted mode. Enrolled, the device line
  // already says what else is missing.
  if (status.relayMode === 'self-host') return status.enrolled ? null : 'push-set-up-phone';
  if (!status.enrolled || status.connection === 'removed') return nothing ? 'push-network' : 'push-hosted-relay';
  return status.connection === 'not-entitled' ? 'push-plans' : null;
}

/** When a line last showed, on this machine: every window shares the origin's storage. */
export const ALARM_UPSELL_SHOWN_AT_KEY = 'dormouse:alarm-upsell-shown-at';
const DAY_MS = 24 * 60 * 60 * 1000;
/** Past the plain preview's life, so a later answer has no preview left to join. */
export const STATUS_READ_MS = 2500;
const isNumber = (value: unknown): value is number => typeof value === 'number';

/** Whether a line showed in the last day. Storage that cannot be read means it has not. */
export function alarmUpsellShownToday(now: number): boolean {
  const last = loadJson(ALARM_UPSELL_SHOWN_AT_KEY, 0, isNumber);
  // A clock set back past the last showing counts as a new day.
  return now >= last && now - last < DAY_MS;
}

function managedVoiceStatus(): ManagedVoiceStatus | null {
  try {
    return getPlatform().managedVoice?.status() ?? null;
  } catch {
    return null;
  }
}

/** The Burrow's status, or `null` once {@link STATUS_READ_MS} passes without one. */
async function readStatusCapped(): Promise<BurrowConsoleStatus | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => resolve(null), STATUS_READ_MS);
  });
  try {
    return await Promise.race([readBurrowStatusOnce(), late]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The line turning `sink` on earns, if none showed in the last day and its
 * preview is `stillShown` once decided; recording the showing spends the day.
 * The cheap answers come first, so a toggle that can earn nothing never asks
 * the Burrow service, and speech never does.
 */
export async function takeAlarmUpsell(
  sink: AlertSink,
  stillShown: () => boolean,
  now: number = Date.now(),
): Promise<AlarmUpsell | null> {
  const network = getNetworkPolicySnapshot();
  if (network.kind !== 'ready' || alarmUpsellShownToday(now)) return null;
  const nothing = network.network.policy.level === 'nothing';
  let upsell: AlarmUpsell | null;
  if (sink === 'speech') {
    upsell = chooseVoiceUpsell(managedVoiceStatus(), nothing);
  } else {
    upsell = choosePushUpsell(await readStatusCapped(), nothing);
  }
  if (!upsell || !stillShown()) return null;
  saveJson(ALARM_UPSELL_SHOWN_AT_KEY, now);
  return upsell;
}

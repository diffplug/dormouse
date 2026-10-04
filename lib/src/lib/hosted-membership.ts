import { useCallback, useSyncExternalStore } from 'react';
import { getPlatformOrNull } from './platform';
import type { ManagedVoiceStatus } from './platform/managed-voice-types';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import {
  burrowLink,
  getBurrowStatusSnapshot,
  subscribeToBurrowStatus,
} from '../remote/burrow/burrow-status-store';

/**
 * This machine's standing with Dormouse Hosted (`docs/specs/alert.md` ->
 * "Settings dialog"). Signing in is enrolling this computer's Burrow with
 * Hosted, so the Burrow service's status is the answer, in Standalone and
 * VS Code alike:
 *
 * - `unavailable`: no Burrow service, a self-host build, or no answer yet —
 *   nothing about Hosted is offered;
 * - `signed-out`: a Hosted build not enrolled, or removed from its account;
 * - `no-plan`: signed in, and the relay socket or managed voice's speak says
 *   the account has no plan;
 * - `member`: signed in, and nothing says the plan lapsed.
 */
export type HostedMembership = 'member' | 'signed-out' | 'no-plan' | 'unavailable';

export type StandingFields = Pick<BurrowConsoleStatus, 'relayMode' | 'enrolled' | 'connection'>;

/** The standing a Burrow status and managed voice's status give. */
export function membershipOf(status: StandingFields | null, voice: ManagedVoiceStatus | null): HostedMembership {
  if (!status || status.relayMode !== 'hosted') return 'unavailable';
  if (!status.enrolled || status.connection === 'removed') return 'signed-out';
  if (status.connection === 'not-entitled' || voice?.notEntitled === true) return 'no-plan';
  return 'member';
}

/** Managed voice's status now, `null` without a port or before its host answers. */
export function voiceStatus(): ManagedVoiceStatus | null {
  return getPlatformOrNull()?.managedVoice?.status() ?? null;
}

/**
 * The Burrow service's standing now, for a caller outside React: the status
 * the Settings dialog's subscription holds, else one read of the service,
 * which publishes nothing. `null` without a service, or on any failure.
 */
export async function readBurrowStanding(): Promise<StandingFields | null> {
  const snapshot = getBurrowStatusSnapshot();
  if (snapshot.kind === 'ready') return snapshot.status;
  const link = burrowLink();
  if (!link) return null;
  try {
    const status = (await link.command('status')) as Partial<StandingFields> | null;
    const known =
      !!status &&
      typeof status.enrolled === 'boolean' &&
      (status.relayMode === 'hosted' || status.relayMode === 'self-host') &&
      typeof status.connection === 'string';
    return known ? (status as StandingFields) : null;
  } catch {
    return null;
  }
}

/** The standing now, for a caller outside React. */
export async function readHostedMembership(): Promise<HostedMembership> {
  return membershipOf(await readBurrowStanding(), voiceStatus());
}

const ignore = () => () => {};
const NO_STATUS = { kind: 'unsupported' } as const;

/**
 * The standing, live: subscribing polls the Burrow service while mounted, as
 * Settings already does. Not `active`, it subscribes to nothing and answers
 * `unavailable`.
 */
export function useHostedMembership(active = true): HostedMembership {
  const burrow = useSyncExternalStore(
    active ? subscribeToBurrowStatus : ignore,
    active ? getBurrowStatusSnapshot : () => NO_STATUS,
  );
  const port = getPlatformOrNull()?.managedVoice;
  const subscribeVoice = useCallback((listener: () => void) => port?.subscribe(listener) ?? (() => {}), [port]);
  const voice = useSyncExternalStore(subscribeVoice, voiceStatus);
  return membershipOf(burrow.kind === 'ready' ? burrow.status : null, voice);
}

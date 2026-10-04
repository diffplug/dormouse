import { useCallback, useSyncExternalStore } from 'react';
import { getPlatformOrNull } from './platform';
import type { ManagedVoicePort, ManagedVoiceStatus } from './platform/managed-voice-types';
import type { BurrowConsoleStatus } from '../host/remote/service-protocol';
import { getBurrowStatusSnapshot, subscribeToBurrowStatus } from '../remote/burrow/burrow-status-store';

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

/** Where an account stands, whichever Relay the build was baked for. */
export function standingOf(
  status: Pick<BurrowConsoleStatus, 'enrolled' | 'connection'>,
  voice: ManagedVoiceStatus | null,
): Exclude<HostedMembership, 'unavailable'> {
  if (!status.enrolled || status.connection === 'removed') return 'signed-out';
  if (status.connection === 'not-entitled' || voice?.notEntitled === true) return 'no-plan';
  return 'member';
}

/** The standing a Burrow status and managed voice's status give, in a Hosted build. */
export function membershipOf(
  status: Pick<BurrowConsoleStatus, 'relayMode' | 'enrolled' | 'connection'> | null,
  voice: ManagedVoiceStatus | null,
): HostedMembership {
  return status?.relayMode === 'hosted' ? standingOf(status, voice) : 'unavailable';
}

/** Managed voice's port, which only a build that can play it carries. */
export function managedVoicePort(): ManagedVoicePort | undefined {
  return getPlatformOrNull()?.managedVoice;
}

/** The port's cached status; `null` without a port or before the host answers. */
export function useManagedVoiceStatus(port: ManagedVoicePort | undefined): ManagedVoiceStatus | null {
  const subscribe = useCallback((listener: () => void) => port?.subscribe(listener) ?? (() => {}), [port]);
  const snapshot = useCallback(() => port?.status() ?? null, [port]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The standing, live: subscribing polls the Burrow service while mounted, as
 * Settings already does. `null` while a service has yet to answer.
 */
export function useHostedMembership(): HostedMembership | null {
  const burrow = useSyncExternalStore(subscribeToBurrowStatus, getBurrowStatusSnapshot);
  const voice = useManagedVoiceStatus(managedVoicePort());
  if (burrow.kind === 'loading') return null;
  return membershipOf(burrow.kind === 'ready' ? burrow.status : null, voice);
}

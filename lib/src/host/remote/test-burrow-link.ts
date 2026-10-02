/**
 * The fake `BurrowLink` and status fixtures the Settings dialog's Remote
 * control section is exercised against.
 *
 * Test-only, and shared on purpose — the same reasoning as
 * `lib/src/remote/test-fake-socket.ts`. `RemoteControlSection` hangs entirely
 * off `getPlatform().burrow`, so its unit test and its stories need the
 * same two things: a link that answers `status` (and the one-time commands),
 * and a {@link BurrowConsoleStatus} to answer it with. Kept typed here, next to
 * the interface it fixtures, so adding a field to that interface breaks this
 * file rather than letting one caller quietly keep asserting the old shape.
 *
 * Imports no test framework: the Storybook preview and the story bundle load
 * this, and neither may pull `vitest` in (the same rule `lib/tsconfig.app.json`
 * records for `wall-test-utils.ts`). Callers that want spies wrap these.
 */

import {
  DEFAULT_PAIRING_TTL_MS,
  ONE_TIME_LINK_TTL_MS,
  formatOneTimeLinkUrl,
  formatPairingInvitationUrl,
  fromBase64Url,
} from 'remote-lib-common';

import { DEFAULT_RELAY_ORIGIN, hostedOrigin, type RelayMode } from '../relay-origin';
import {
  idleOneTimeState,
  type InvitationEvent,
  type BurrowConsoleStatus,
  type SetupQrResult,
} from './service-protocol';
import type { PairingOutcome, TerminalInvitationState } from '../../remote/burrow/burrow-runtime';
import type { OneTimeState } from '../../remote/burrow/one-time-runtime';
import { networkPolicyResult, type NetworkPolicy, type NetworkPolicyResult } from '../../remote/network-policy';
import type { BurrowLink } from '../../lib/platform/types';

/** The self-host Relay the fixtures' build was baked for (`docs/specs/burrow-service.md` → "Relay origin"). */
export const SELF_HOST_RELAY_ORIGIN = 'https://ned-mac.tail9c2f1.ts.net';

/**
 * A stock build that has never enrolled: its Relay is Hosted's, so Persistent
 * Relay offers nothing to enroll, and its one-time connection is on.
 */
export const UNENROLLED_STATUS: BurrowConsoleStatus = {
  enrolled: false,
  serving: false,
  relayOrigin: DEFAULT_RELAY_ORIGIN,
  relayMode: 'hosted',
  burrowId: null,
  connection: 'idle',
  pairedClients: 0,
  suggestedLabel: 'ned-mac',
  offer: false,
  hostedEnrollment: null,
  accountOrigin: 'https://hosted.dormouse.sh',
};

/**
 * A self-host build that has never enrolled: the section shows its two-field
 * form under the origin it was built for, and no one-time connection.
 */
export const SELF_HOST_UNENROLLED_STATUS: BurrowConsoleStatus = {
  ...UNENROLLED_STATUS,
  relayOrigin: SELF_HOST_RELAY_ORIGIN,
  relayMode: 'self-host',
  accountOrigin: null,
};

/**
 * Un-enrolled *and* a Dormouse Relay installed on this machine: the section
 * leads with the one-click offer card and folds the typed form away.
 */
export const OFFER_STATUS: BurrowConsoleStatus = {
  ...SELF_HOST_UNENROLLED_STATUS,
  offer: true,
};

/** An enrolled machine, with the fields a caller is likely to vary. */
export function enrolledStatus(
  over: Partial<BurrowConsoleStatus> = {},
): BurrowConsoleStatus {
  return {
    // An enrolled Burrow reports no offer, whatever is on disk.
    ...SELF_HOST_UNENROLLED_STATUS,
    enrolled: true,
    serving: true,
    burrowId: 'burrow-6f1c2a90',
    connection: 'connected',
    ...over,
  };
}

/**
 * A setup code as `setupQr` answers one: the positional `#pair?` URL, the
 * invitation it belongs to, and its clock. Composed by the real formatter, so a
 * grammar change reaches the fixture too — and so a fixture that would not
 * scan fails here rather than in a story.
 *
 * The expiry is relative to *now* rather than a fixed epoch, because the panel
 * renders the minutes left — a frozen timestamp would render "expired" in every
 * story. `DEFAULT_PAIRING_TTL_MS` out, which is the real TTL
 * (`relay/src/setup-token.ts`), so the copy reads as it does in the app.
 */
export function setupQrResult(over: Partial<SetupQrResult> = {}): SetupQrResult {
  const expiresAt = Date.now() + DEFAULT_PAIRING_TTL_MS;
  const inviteId = 'Hs4mZbC1uKq7VnP0LxDgTf';
  const ephPubBase64Url = '3PkQ8sV2mYb1hZr7Lw0cJdN6xTgAeUiOpqRsFuHv9Kz';
  return {
    url: formatPairingInvitationUrl('https://ned-mac.tail9c2f1.ts.net', {
      burrowId: 'Zq7WmT1cX4bK0nLpRvYeAg',
      inviteId,
      expiry: Math.floor(expiresAt / 1000),
      setupToken: 'B2xNc7QvKm0TdLa9YsEuPfHi4RgWjZo1UbXn6Vt3ARk',
      ephPub: new Uint8Array(32),
      ephPubBase64Url,
    }),
    inviteId,
    expiresAt,
    ...over,
  };
}

/**
 * A one-time connection waiting for its phone, as `oneTimeStatus` and
 * `oneTimeOpen` answer one: the link composed by the real formatter against the
 * shipped rendezvous, so a grammar change reaches the fixture, and its expiry
 * relative to now (with the real TTL) for the reason {@link setupQrResult}'s is.
 */
export function oneTimeWaiting(
  over: Partial<Extract<OneTimeState, { status: 'waiting' }>> = {},
): Extract<OneTimeState, { status: 'waiting' }> {
  const expiry = Math.floor((Date.now() + ONE_TIME_LINK_TTL_MS) / 1000);
  const ephPubBase64Url = '7Hq2LmZx9cVb4NtRkWpYsD0aFgJ1uEiO3yTnC6hQ5Ks';
  return {
    status: 'waiting',
    url: formatOneTimeLinkUrl(DEFAULT_RELAY_ORIGIN, {
      roomId: 'Rm4qT0vXc8LbN2kZyPaE1w',
      expiry,
      ephPub: fromBase64Url(ephPubBase64Url),
      ephPubBase64Url,
    }),
    // The link's last live millisecond, as the runtime reports it.
    expiresAt: expiry * 1000,
    ...over,
  };
}

/** The one Wi-Fi the fixtures' Local networks allows. */
export const LAN = '192.168.1.0/24';
/** A self-host build's network on: My Relay only. */
export const RELAY_ON: NetworkPolicy = { level: 'relay', allowed: [], autoUpdate: false };
/** A Hosted build's network on: Local networks over {@link LAN}. */
export const LOCAL_ON: NetworkPolicy = { level: 'local', allowed: [LAN], autoUpdate: false };
/** A Hosted build's network on everywhere: Anywhere, no network allowed. */
export const ANYWHERE_ON: NetworkPolicy = { level: 'anywhere', allowed: [], autoUpdate: false };

/**
 * What `networkPolicy` answers for a build with its network on, which the
 * Remote control choices' fixtures assume.
 */
export function networkOn(relayMode: RelayMode): NetworkPolicyResult {
  return networkPolicyResult(relayMode === 'self-host' ? RELAY_ON : LOCAL_ON, relayMode, [
    { id: 'en0', label: 'Local network', kind: 'lan', prefixes: [LAN] },
  ]);
}

/** A link that answers through its `command` and relays {@link emit} to its subscribers. */
export interface EventedBurrowLink<C extends BurrowLink['command']> extends BurrowLink {
  /** Exactly the `command` it was made with, so a caller's spy reads its calls here. */
  readonly command: C;
  /** Deliver `data` to every listener subscribed to `name`, as the bridge would. */
  emit(name: string, data: unknown): void;
  /** How many listeners `name` has. */
  listening(name: string): number;
}

/**
 * A link a case drives by hand: `command` answers every command, and
 * {@link EventedBurrowLink.emit} stands in for the service's pushed events. The
 * listener map the Settings section's, the one-time store's, and the
 * indicator's tests all need, kept here so a caller wanting spies passes a
 * `vi.fn` as `command` rather than this file importing a framework.
 */
export function makeEventedBurrowLink<C extends BurrowLink['command']>(
  command: C,
): EventedBurrowLink<C> {
  const listeners = new Map<string, Set<(data: unknown) => void>>();
  return {
    command,
    respond: () => {},
    notify: () => {},
    on: (name, listener) => {
      const set = listeners.get(name) ?? new Set<(data: unknown) => void>();
      set.add(listener);
      listeners.set(name, set);
      return () => void set.delete(listener);
    },
    emit(name, data) {
      for (const listener of listeners.get(name) ?? []) listener(data);
    },
    listening: (name) => listeners.get(name)?.size ?? 0,
  };
}

/** What {@link makeStubBurrowLink} should answer. */
export interface PrimedBurrow {
  /** What `status` answers. */
  status?: BurrowConsoleStatus;
  /** Make `status` reject — "could not reach this machine's remote-control service". */
  statusError?: string;
  /**
   * Make `enroll` *and* `enrollOffer` reject — the refused-origin case both
   * render inline, in the same place and the same words.
   */
  enrollError?: string;
  /** What `setupQr` answers; defaults to {@link setupQrResult}. */
  setupQr?: SetupQrResult;
  /** Make `setupQr` reject — the relay is down, or the Relay refused. */
  setupQrError?: string;
  /**
   * Fire one `invitation` event as soon as something subscribes, so the panel
   * renders that terminal state. A story is one frame, so "the phone reserved
   * the code" has to be a starting condition rather than an event to wait for.
   */
  setupInvitation?: TerminalInvitationState;
  /**
   * How the ceremony that code produced ended, on the same event. Implies
   * `consumed` where {@link PrimedBurrow.setupInvitation} says nothing,
   * because that is the only state the Burrow ever reports an outcome with
   * (`service-protocol.ts` → `InvitationEvent`).
   */
  setupOutcome?: PairingOutcome;
  /** What `oneTimeStatus` answers; by default what the status's build would. */
  oneTime?: OneTimeState;
  /** What `oneTimeOpen` answers; {@link oneTimeWaiting} by default. */
  oneTimeOpen?: OneTimeState;
  /** Make `oneTimeOpen` reject — a build that cannot open one, or a phone already connected. */
  oneTimeOpenError?: string;
  /** What `networkPolicy` answers; {@link networkOn} for the status's build by default. */
  network?: NetworkPolicyResult;
}

/**
 * A link that answers from a fixed status rather than a real Burrow service.
 *
 * Deliberately not a scenario engine: a story is one frame, so `enroll`,
 * `enrollOffer`, `reconnect`, `clearEnrollment` and `oneTimeEnd` resolve without
 * changing the answer. The exception is `enrollError`, because a refused enrollment is a state the
 * form must render (`docs/specs/burrow-service.md`, "Remote control, in the Settings
 * dialog") and a rejected enroll is the only way to reach it. And
 * `setNetworkPolicy` holds what it was sent and answers it, as the service
 * does, so a story can walk Settings → Network's choices; `dismissPathRefusal`
 * drops the refusal it holds.
 */
export function makeStubBurrowLink(primed: PrimedBurrow): BurrowLink {
  const { relayOrigin, relayMode } = primed.status ?? UNENROLLED_STATUS;
  let network = primed.network ?? networkOn(relayMode);
  return {
    command: async (cmd, params) => {
      if (cmd === 'status') {
        if (primed.statusError) throw new Error(primed.statusError);
        return primed.status ?? UNENROLLED_STATUS;
      }
      if ((cmd === 'enroll' || cmd === 'enrollOffer') && primed.enrollError) {
        throw new Error(primed.enrollError);
      }
      if (cmd === 'setupQr') {
        if (primed.setupQrError) throw new Error(primed.setupQrError);
        return primed.setupQr ?? setupQrResult();
      }
      if (cmd === 'networkPolicy') return network;
      if (cmd === 'setNetworkPolicy') {
        const { policy } = params as { policy: NetworkPolicy };
        network = networkPolicyResult(policy, relayMode, network.interfaces, network.refusal ?? null);
        return network;
      }
      if (cmd === 'dismissPathRefusal') {
        network = networkPolicyResult(network.policy, relayMode, network.interfaces);
        return network;
      }
      if (cmd === 'oneTimeStatus') {
        return (
          primed.oneTime ??
          idleOneTimeState(hostedOrigin({ origin: relayOrigin, mode: relayMode }), network.policy.level)
        );
      }
      if (cmd === 'oneTimeOpen') {
        if (primed.oneTimeOpenError) throw new Error(primed.oneTimeOpenError);
        return primed.oneTimeOpen ?? oneTimeWaiting();
      }
      if (cmd === 'oneTimeEnd') return {};
      return null;
    },
    respond: () => {},
    notify: () => {},
    on: (name, listener) => {
      if (name === 'invitation' && (primed.setupInvitation || primed.setupOutcome)) {
        // Naming the invitation the stub's own `setupQr` answered, because the
        // panel acts only on its own code (`service-protocol.ts`).
        const { inviteId } = primed.setupQr ?? setupQrResult();
        // Spread like the service's own `#emitInvitation`, so no story or test
        // drives the panel with a shape production cannot send.
        const event: InvitationEvent = {
          name: 'invitation',
          inviteId,
          state: primed.setupInvitation ?? 'consumed',
          ...(primed.setupOutcome ? { outcome: primed.setupOutcome } : {}),
        };
        // A microtask rather than inline: the panel subscribes during an effect,
        // and setting state before that effect has returned is a no-op React
        // warns about.
        queueMicrotask(() => listener(event));
      }
      return () => {};
    },
  };
}

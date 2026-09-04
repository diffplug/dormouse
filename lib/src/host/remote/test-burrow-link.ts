/**
 * The fake `BurrowLink` and status fixtures the Settings dialog's Remote
 * control section is exercised against.
 *
 * Test-only, and shared on purpose — the same reasoning as
 * `lib/src/remote/test-fake-socket.ts`. `RemoteControlSection` hangs entirely
 * off `getPlatform().burrow`, so its unit test and its stories need the
 * same two things: a link that answers `status`, and a
 * {@link BurrowConsoleStatus} to answer it with. Kept typed here, next to
 * the interface it fixtures, so adding a field to that interface breaks this
 * file rather than letting one caller quietly keep asserting the old shape.
 *
 * Imports no test framework: the Storybook preview and the story bundle load
 * this, and neither may pull `vitest` in (the same rule `lib/tsconfig.app.json`
 * records for `wall-test-utils.ts`). Callers that want spies wrap these.
 */

import { DEFAULT_PAIRING_TTL_MS, formatPairingInvitationUrl } from 'remote-lib-common';

import type { InvitationEvent, BurrowConsoleStatus, SetupQrResult } from './service-protocol';
import type { PairingOutcome, TerminalInvitationState } from '../../remote/burrow/burrow-runtime';
import type { BurrowLink } from '../../lib/platform/types';

/** A machine that has never enrolled: the section shows its three-field form. */
export const UNENROLLED_STATUS: BurrowConsoleStatus = {
  enrolled: false,
  relayUrl: null,
  burrowId: null,
  connection: 'idle',
  pairedClients: 0,
  suggestedLabel: 'ned-mac',
  offer: null,
};

/**
 * Un-enrolled *and* a Dormouse Relay installed on this machine: the section
 * leads with the one-click offer card and folds the typed form away.
 */
export const OFFER_STATUS: BurrowConsoleStatus = {
  ...UNENROLLED_STATUS,
  offer: { origin: 'https://ned-mac.tail9c2f1.ts.net' },
};

/** An enrolled machine, with the fields a caller is likely to vary. */
export function enrolledStatus(
  over: Partial<BurrowConsoleStatus> = {},
): BurrowConsoleStatus {
  return {
    enrolled: true,
    relayUrl: 'https://ned-mac.tail9c2f1.ts.net',
    burrowId: 'burrow-6f1c2a90',
    connection: 'connected',
    pairedClients: 0,
    suggestedLabel: 'ned-mac',
    // An enrolled Burrow reports no offer, whatever is on disk.
    offer: null,
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
}

/**
 * A link that answers from a fixed status rather than a real Burrow service.
 *
 * Deliberately not a scenario engine: a story is one frame, so `enroll`,
 * `enrollOffer`, `reconnect` and `clearEnrollment` resolve without changing the
 * answer. The exception is `enrollError`, because a refused origin is a state the
 * form must render (`docs/specs/relay.md`, "Remote control, in the Settings
 * dialog") and a rejected enroll is the only way to reach it.
 */
export function makeStubBurrowLink(primed: PrimedBurrow): BurrowLink {
  return {
    command: async (cmd) => {
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

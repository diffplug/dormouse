/**
 * The fake `RemoteHostLink` and status fixtures the Settings dialog's Remote
 * control section is exercised against.
 *
 * Test-only, and shared on purpose — the same reasoning as
 * `lib/src/remote/test-fake-socket.ts`. `RemoteControlSection` hangs entirely
 * off `getPlatform().remoteHost`, so its unit test and its stories need the
 * same two things: a link that answers `status`, and a
 * {@link RemoteHostConsoleStatus} to answer it with. Kept typed here, next to
 * the interface it fixtures, so adding a field to that interface breaks this
 * file rather than letting one caller quietly keep asserting the old shape.
 *
 * Imports no test framework: the Storybook preview and the story bundle load
 * this, and neither may pull `vitest` in (the same rule `lib/tsconfig.app.json`
 * records for `wall-test-utils.ts`). Callers that want spies wrap these.
 */

import {
  DEFAULT_PAIRING_TTL_MS,
  SETUP_HASH_NONCE_PARAM,
  SETUP_HASH_PREFIX,
  SETUP_HASH_TOKEN_PARAM,
} from 'server-lib-common';

import type { RemoteHostConsoleStatus, SetupQrResult } from './service-protocol';
import type { RemoteHostLink } from '../../lib/platform/types';

/** A machine that has never enrolled: the section shows its three-field form. */
export const UNENROLLED_STATUS: RemoteHostConsoleStatus = {
  enrolled: false,
  serverUrl: null,
  hostId: null,
  connection: 'idle',
  pairedClients: 0,
  suggestedLabel: 'ned-mac',
  offer: null,
};

/**
 * Un-enrolled *and* a Dormouse server installed on this machine: the section
 * leads with the one-click offer card and folds the typed form away.
 */
export const OFFER_STATUS: RemoteHostConsoleStatus = {
  ...UNENROLLED_STATUS,
  offer: { origin: 'https://ned-mac.tail9c2f1.ts.net' },
};

/** An enrolled machine, with the fields a caller is likely to vary. */
export function enrolledStatus(
  over: Partial<RemoteHostConsoleStatus> = {},
): RemoteHostConsoleStatus {
  return {
    enrolled: true,
    serverUrl: 'https://ned-mac.tail9c2f1.ts.net',
    hostId: 'host-6f1c2a90',
    connection: 'connected',
    pairedClients: 0,
    suggestedLabel: 'ned-mac',
    // An enrolled Host reports no offer, whatever is on disk.
    offer: null,
    ...over,
  };
}

/**
 * A setup code as `setupQr` answers one: a `#setup?token=…&nonce=…` URL, the
 * mint it came from, and its clock. Composed from the same `wire.ts` constants
 * the real emitter uses, so a grammar change reaches the fixture too.
 *
 * The expiry is relative to *now* rather than a fixed epoch, because the panel
 * renders the minutes left — a frozen timestamp would render "expired" in every
 * story. `DEFAULT_PAIRING_TTL_MS` out, which is the real TTL
 * (`server/src/setup-token.ts`), so the copy reads as it does in the app.
 */
export function setupQrResult(over: Partial<SetupQrResult> = {}): SetupQrResult {
  const hash = new URLSearchParams({
    [SETUP_HASH_TOKEN_PARAM]: '3PkQ8sV2mYb1hZr7Lw0cJdN6xTgAeUiOpqRsFuHv9Kz',
    [SETUP_HASH_NONCE_PARAM]: 'Hs4mZbC1uKq7VnP0LxDgTfE8yRjWaOiUcQtBv3MdN2s',
  });
  return {
    url: `https://ned-mac.tail9c2f1.ts.net/${SETUP_HASH_PREFIX}${hash}`,
    mintId: 'mint-story',
    expiresAt: Date.now() + DEFAULT_PAIRING_TTL_MS,
    ...over,
  };
}

/** What {@link makeStubRemoteHostLink} should answer. */
export interface PrimedRemoteHost {
  /** What `status` answers. */
  status?: RemoteHostConsoleStatus;
  /** Make `status` reject — "could not reach this machine's Host service". */
  statusError?: string;
  /**
   * Make `enroll` *and* `enrollOffer` reject — the refused-origin case both
   * render inline, in the same place and the same words.
   */
  enrollError?: string;
  /** What `setupQr` answers; defaults to {@link setupQrResult}. */
  setupQr?: SetupQrResult;
  /** Make `setupQr` reject — the relay is down, or the server refused. */
  setupQrError?: string;
  /**
   * Fire `setupTokenRedeemed` as soon as something subscribes, so the panel
   * renders its scanned state. A story is one frame, so "the phone redeemed the
   * code" has to be a starting condition rather than an event to wait for.
   */
  setupRedeemed?: boolean;
}

/**
 * A link that answers from a fixed status rather than a real Host service.
 *
 * Deliberately not a scenario engine: a story is one frame, so `enroll`,
 * `enrollOffer`, `reconnect` and `clearEnrollment` resolve without changing the
 * answer. The exception is `enrollError`, because a refused origin is a state the
 * form must render (`docs/specs/server.md`, "Remote control, in the Settings
 * dialog") and a rejected enroll is the only way to reach it.
 */
export function makeStubRemoteHostLink(primed: PrimedRemoteHost): RemoteHostLink {
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
      if (name === 'setupTokenRedeemed' && primed.setupRedeemed) {
        // Naming the mint the stub's own `setupQr` answered, because the panel
        // acts only on its own code (`service-protocol.ts`).
        const { mintId } = primed.setupQr ?? setupQrResult();
        // A microtask rather than inline: the panel subscribes during an effect,
        // and setting state before that effect has returned is a no-op React
        // warns about.
        queueMicrotask(() => listener({ name: 'setupTokenRedeemed', mintId }));
      }
      return () => {};
    },
  };
}

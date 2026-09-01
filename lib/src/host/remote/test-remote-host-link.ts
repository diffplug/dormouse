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

import type { RemoteHostConsoleStatus } from './service-protocol';
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
      return null;
    },
    respond: () => {},
    notify: () => {},
    on: () => () => {},
  };
}

/**
 * Arm something only while there is a Burrow to serve.
 *
 * Answering the Burrow is free — a webview replies to an ask and goes back to
 * sleep — but *volunteering* is not: announcing that the directory may have
 * changed costs a crossing into the Burrow's process on every pane-state change,
 * every activity change, and every focus move, and watching for unattended
 * rings costs a subscription to the activity store, forever, on a machine whose
 * owner may never enroll a Burrow at all.
 *
 * So the outbound half is gated on the service's own answer: it announces
 * `{ name: 'status', enrolled }` whenever its lifecycle changes that
 * (`lib/src/host/remote/service.ts`), and the seed is one `status` command at
 * install time, because a webview that opens after the enrollment would
 * otherwise wait for a change that already happened.
 */

import type { BurrowConsoleStatus, BurrowStatusEvent } from '../../host/remote/service-protocol';
import type { BurrowLink } from '../../lib/platform/types';

/**
 * Run `arm` while the Burrow service is enrolled and its disarm when it is not,
 * starting from whatever `status` reports. Returns the disposer, which disarms
 * too.
 *
 * The seed cannot lose a race with the event: both travel the same ordered
 * channel, so a status that changed after the command was sent arrives as an
 * event behind the seed's own result.
 */
export function armWhileEnrolled(link: BurrowLink, arm: () => () => void): () => void {
  let disarm: (() => void) | null = null;

  const apply = (enrolled: boolean): void => {
    if (enrolled === !!disarm) return;
    if (enrolled) {
      disarm = arm();
      return;
    }
    disarm?.();
    disarm = null;
  };

  const unsubscribe = link.on('status', (data) => {
    apply(!!(data as BurrowStatusEvent | null)?.enrolled);
  });
  void link
    .command('status')
    .then((status) => apply(!!(status as BurrowConsoleStatus | null)?.enrolled))
    // No Burrow to report one: nothing to arm, which is already the state.
    .catch(() => {});

  return () => {
    unsubscribe();
    apply(false);
  };
}

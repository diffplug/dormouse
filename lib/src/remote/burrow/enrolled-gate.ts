/**
 * Arm something only while there is a Burrow to serve.
 *
 * Answering the Burrow is free — a webview replies to an ask and goes back to
 * sleep — but *volunteering* is not: announcing that the directory may have
 * changed costs a crossing into the Burrow's process on every pane-state change,
 * every activity change, and every focus move, on a machine whose owner may
 * never enroll a Burrow at all.
 *
 * So the outbound half is gated on the service's own answer: it announces
 * `{ name: 'status', enrolled, serving, serviceId }` whenever its lifecycle
 * changes either, and once as it starts (`lib/src/host/remote/service.ts`),
 * and the seed is one `status` command at
 * install time, because a webview that opens after the enrollment would
 * otherwise wait for a change that already happened.
 *
 * Two gates ride that one answer:
 *
 * - **`enrolled`** — there is a Relay: what only an enrollment has, the push
 *   device list.
 * - **`serving`** — something can reach this machine's terminals: enrolled, or
 *   a one-time connection opening, waiting, confirming, or live. The surface
 *   responder's announcements and the approval mirror arm on this, since a
 *   one-time phone needs both and no enrollment.
 */

import type { BurrowConsoleStatus, BurrowStatusEvent } from '../../host/remote/service-protocol';
import type { BurrowLink } from '../../lib/platform/types';

/** What a gate arms on: a field of the service's `status`. */
export type BurrowGate = 'enrolled' | 'serving';

/** One gate's arming: runs on the rising edge, and returns its disarm. */
export type GateArm = () => () => void;

/** Whether `gate` is open in a `status` answer or event. */
function gateOpen(
  gate: BurrowGate,
  status: Partial<Pick<BurrowStatusEvent, 'enrolled' | 'serving'>> | null | undefined,
): boolean {
  return !!status?.[gate];
}

/**
 * Run each arm while its gate is open and its disarm when it closes, starting
 * from whatever `status` reports. One subscription and one seed however many
 * gates, since the un-enrolled seed reads the installer's offer file. Returns
 * the disposer, which disarms everything too.
 *
 * The seed cannot lose a race with the event: both travel the same ordered
 * channel, so a status that changed after the command was sent arrives as an
 * event behind the seed's own result.
 */
export function armWhile(
  link: BurrowLink,
  arms: Partial<Record<BurrowGate, GateArm>>,
): () => void {
  const gates = (Object.keys(arms) as BurrowGate[]).map((gate) => ({
    gate,
    arm: arms[gate]!,
    disarm: null as (() => void) | null,
  }));

  const apply = (status: Partial<BurrowStatusEvent> | BurrowConsoleStatus | null | undefined): void => {
    for (const entry of gates) {
      const open = gateOpen(entry.gate, status);
      if (open === !!entry.disarm) continue;
      if (open) {
        entry.disarm = entry.arm();
        continue;
      }
      entry.disarm?.();
      entry.disarm = null;
    }
  };

  const unsubscribe = link.on('status', (data) => apply(data as BurrowStatusEvent | null));
  void link
    .command('status')
    .then((status) => apply(status as BurrowConsoleStatus | null))
    // No Burrow to report one: nothing to arm, which is already the state.
    .catch(() => {});

  return () => {
    unsubscribe();
    apply(null);
  };
}

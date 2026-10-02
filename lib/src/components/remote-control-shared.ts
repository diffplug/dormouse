import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { getNetworkPolicySnapshot, subscribeToNetworkPolicy } from '../remote/burrow/network-policy-store';
import type { PathRefusal } from '../remote/direct/path-refusal';
import type { NetworkPolicy } from '../remote/network-policy';

/**
 * What the Remote control choices' two QR panels share: the Relay's "Set up a
 * phone" (`RemoteControlSection.tsx`) and the one-time connection
 * (`OneTimeConnection.tsx`), whose Baseboard indicator (`OneTimeIndicator.tsx`)
 * repeats its connected sentence — and the hooks and helpers the Settings
 * dialog and its Network panels share with them.
 */

export const FIELD_LABEL = 'text-xs text-muted';
export const FIELD_HINT = `${FIELD_LABEL} mt-1 block`;

/** The network policy, or `null` before the service answers or without one. */
export function useNetworkPolicy(): NetworkPolicy | null {
  const network = useSyncExternalStore(subscribeToNetworkPolicy, getNetworkPolicySnapshot);
  return network.kind === 'ready' ? network.network.policy : null;
}

/** An origin's host, as the copy names it. */
export function hostOf(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * A busy/error pair for an action surface with one error location; `run`
 * answers whether the action succeeded. Enrollment uses its cross-form gate
 * instead (`RemoteControlSection.tsx`).
 */
export function useBusyAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (action: () => Promise<void>): Promise<boolean> => {
    setBusy(true);
    setError(null);
    try {
      await action();
      return true;
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
      return false;
    } finally {
      setBusy(false);
    }
  }, []);

  return { busy, error, run };
}

/**
 * What the person at this machine reads when the path ended a phone's session
 * (`docs/specs/remote-network.md` -> "Local networks"): one wording for
 * Settings → Network, which says when, above its allowed networks, and for a
 * one-time connection's ending. Only a refusal of the phone's end blames the
 * phone's network; one of this machine's end says this computer was off them.
 * An address the phone `reported` is named as its claim, never as where it
 * connected from, nor as off the allowed networks.
 */
export function pathRefusalSentence(
  refusal: PathRefusal,
  place: 'network-panel' | 'one-time',
  now: number = Date.now(),
): string {
  const panel = place === 'network-panel';
  const when = panel ? `${refusalTime(refusal.at, now)} ` : '';
  const phone = panel ? `${when}a phone` : 'The phone';
  const end = panel ? '.' : ', so the connection ended.';
  const allowed = panel ? 'a network allowed below' : 'one of your allowed networks';
  if (!('end' in refusal)) {
    return `${phone} couldn’t reach this computer over ${panel ? 'an allowed network' : 'one of your allowed networks'}${end}`;
  }
  if (refusal.end === 'local') {
    const own = refusal.localAddress === undefined ? '' : ` (its address was ${refusal.localAddress})`;
    return panel
      ? `${when}a phone couldn’t connect: this computer wasn’t on ${allowed}${own}.`
      : `This computer wasn’t on ${allowed}${own}${end}`;
  }
  if (refusal.address === undefined) {
    return `${phone} tried to connect from outside ${panel ? 'the networks allowed below' : 'your allowed networks'}${end}`;
  }
  if (refusal.addressSource === 'reported') {
    const over = panel ? 'an allowed network' : 'one of your allowed networks';
    return `${phone} couldn’t connect directly over ${over} (it reported ${refusal.address})${end}`;
  }
  return `${phone} tried to connect from ${refusal.address}, which isn’t on ${allowed}${end}`;
}

/**
 * When `at` was, as this machine's clock shows it, leading a sentence: `At`
 * hours and minutes today, `On` a date before them otherwise — a refusal stays
 * until dismissed, so it can be days old.
 */
function refusalTime(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const time = date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === today.toDateString()) return `At ${time}`;
  const day = date.toLocaleDateString(undefined, {
    month: 'short',
    day: 'numeric',
    ...(date.getFullYear() === today.getFullYear() ? {} : { year: 'numeric' }),
  });
  return `On ${day} at ${time}`;
}

/** What a connected one-time phone can do, as the panel and the indicator's tooltip say it. */
export function oneTimeControlSentence(label: string): string {
  return `${label || '(unnamed)'} has full control of your terminals.`;
}

/**
 * A lookup into one of the section's copy tables, answering only for a key the
 * table actually holds.
 *
 * **Never the `in` operator.** Every one of these tables is keyed by a string
 * the Burrow chose and a bridge relayed, and `in` walks the prototype chain — so
 * `'toString'` would answer "yes, there is copy for that" and hand back
 * `Object.prototype.toString` to render. The stores check that those fields are
 * strings and deliberately *not* that they are members of the closed set
 * (`burrow-status-store.ts`, `isOneTimeState`), so this is where a stranger
 * stops. `hasOwnProperty.call` rather than `Object.hasOwn`, which is ES2022 and
 * this build's lib is ES2020.
 */
export function own<T>(table: Record<string, T>, key: string): T | undefined {
  return Object.prototype.hasOwnProperty.call(table, key) ? table[key] : undefined;
}

/**
 * Whole minutes until `expiresAt`, never negative, or `null` with nothing to
 * count down to.
 *
 * The copy names whole minutes, so this re-renders on the minute rather than on
 * a clock tick: a 1 Hz interval bought ~300 renders per code for five numbers,
 * and left Storybook repainting forever after the code expired.
 */
export function useMinutesLeft(expiresAt: number | null): number | null {
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (expiresAt === null) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      const at = Date.now();
      setNow(at);
      const remaining = expiresAt - at;
      // Expired: the number cannot change again, so nothing re-arms.
      if (remaining <= 0) return;
      timer = setTimeout(arm, remaining % 60_000 || 60_000);
    };
    arm();
    return () => clearTimeout(timer);
  }, [expiresAt]);

  return expiresAt === null ? null : Math.max(0, Math.ceil((expiresAt - now) / 60_000));
}

/**
 * Scroll a code panel into view, from its QR's `onShown` (`ExpiringCode`): the
 * panel grows below the fold of the Settings dialog when its QR arrives, so the
 * person who asked for it would otherwise have to go looking. From the QR's own
 * mount rather than when the code is known: the encoder is a lazy chunk, and a
 * panel revealed before it lands grows back below the fold. `block: 'nearest'`
 * leaves a panel that is already visible where it is.
 */
export function revealPanel(panel: HTMLElement | null): void {
  panel?.scrollIntoView?.({ block: 'nearest' });
}

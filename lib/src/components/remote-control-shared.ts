import { useEffect, useState } from 'react';

/**
 * What the Remote control section's two QR panels share: the Relay's "Set up a
 * phone" (`RemoteControlSection.tsx`) and the one-time connection
 * (`OneTimeConnection.tsx`), whose Baseboard indicator (`OneTimeIndicator.tsx`)
 * repeats its connected sentence.
 */

export const FIELD_LABEL = 'text-xs text-muted';
export const FIELD_HINT = `${FIELD_LABEL} mt-1 block`;

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

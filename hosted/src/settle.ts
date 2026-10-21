import type { Computer, HostedVoice } from "./api";

/** The part of the account page's state a change finished elsewhere shows in. */
export interface AccountState {
  voice: HostedVoice | null;
  computers: Computer[] | null;
}

/**
 * What an approval's redemption changes on the page, read against the state
 * before it: Natural Voice turning on, or a computer not listed before. Null
 * when no change could show it: voice already on, or no computers list to
 * compare with.
 */
export function approvalShows(
  purpose: "remote" | "voice",
  before: AccountState,
): ((after: AccountState) => boolean) | null {
  if (purpose === "voice")
    return before.voice?.on ? null : (after) => after.voice?.on === true;
  if (!before.computers) return null;
  const known = new Set(before.computers.map((computer) => computer.burrowId));
  return (after) =>
    !!after.computers?.some((computer) => !known.has(computer.burrowId));
}

export type Settled = "done" | "timeout" | "cancelled";

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads every `intervalMs` until a read satisfies `done`, `timeoutMs` passes,
 * or `cancelled()` holds. A read that fails, or resolves `undefined` (one a
 * newer read superseded), only waits for the next.
 */
export async function settle<T>(
  read: () => Promise<T | undefined>,
  done: (value: T) => boolean,
  options: {
    intervalMs: number;
    timeoutMs: number;
    cancelled: () => boolean;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<Settled> {
  const { intervalMs, timeoutMs, cancelled, wait = delay } = options;
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await wait(intervalMs);
    if (cancelled()) return "cancelled";
    const value = await read().catch(() => undefined);
    if (cancelled()) return "cancelled";
    if (value !== undefined && done(value)) return "done";
  }
  return "timeout";
}

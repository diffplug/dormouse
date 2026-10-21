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

/** A failed read of the account: the next successful read clears its error. */
export class ReadFailed extends Error {}

/** `read`, any failure of it a {@link ReadFailed}. */
export const asRead = <T>(read: Promise<T>): Promise<T> =>
  read.catch((error: unknown) => {
    throw new ReadFailed(pageError(error).message);
  });

/** An error the page shows; `read` when a failed read of the account caused it. */
export interface PageError {
  message: string;
  read: boolean;
}

/** The page's error for one an action or a read threw. */
export function pageError(error: unknown): PageError {
  return {
    message:
      error instanceof Error
        ? error.message
        : "Something went wrong. Please try again.",
    read: error instanceof ReadFailed,
  };
}

/**
 * The error a successful read leaves: none in place of a failed read's, which
 * it answers; any other until the next action.
 */
export const afterRead = (error: PageError | null) =>
  error?.read ? null : error;

/**
 * Reads the account after a mutation that succeeded: a failed read calls
 * `failed` and resolves `undefined`, never rejecting as if the mutation had
 * failed.
 */
export async function reread<T>(
  read: () => Promise<T>,
  failed: () => void,
): Promise<T | undefined> {
  try {
    return await read();
  } catch {
    failed();
    return undefined;
  }
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

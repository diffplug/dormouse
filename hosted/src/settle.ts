import type { ApprovalState, Computer, HostedVoice } from "./api";

/** The part of the account page's state a change finished elsewhere shows in. */
export interface AccountState {
  voice: HostedVoice | null;
  computers: Computer[] | null;
  /** The approval the page waits on; unset when none is, or its read failed. */
  approval?: ApprovalState;
}

/** A notice the page shows; `error` when it reports a failure. */
export interface Notice {
  text: string;
  error?: boolean;
}

/** An approval Dormouse on the computer finishes after the page's mutation. */
export interface Pending {
  /** The approved user code, read while the page waits. */
  userCode: string;
  /** Whether the account, as last read, shows the change. */
  shows: (after: AccountState) => boolean;
  waiting: string;
  done: string;
  late: string;
  /** Once a read finds the digits typed were not the computer's. */
  mismatch: string;
}

/**
 * The notice a read of the account ends `pending` with, or null while it
 * shows neither end. A mismatch first: that approval never redeems, so a
 * change shown beside it is another's.
 */
export function pendingEnd(
  pending: Pending,
  after: AccountState,
): Notice | null {
  if (after.approval?.mismatched) return { text: pending.mismatch, error: true };
  return pending.shows(after) ? { text: pending.done } : null;
}

/**
 * What shows an approval redeemed, read against the state before it: Natural
 * Voice turning on, or a computer not listed before. Where no change could
 * show it (voice already on, or no computers list to compare with), the
 * approval's own read saying it was redeemed.
 */
export function approvalShows(
  purpose: "remote" | "voice",
  before: AccountState,
): (after: AccountState) => boolean {
  const redeemed = (after: AccountState) => after.approval?.redeemed === true;
  if (purpose === "voice")
    return before.voice?.on ? redeemed : (after) => after.voice?.on === true;
  if (!before.computers) return redeemed;
  const known = new Set(before.computers.map((computer) => computer.burrowId));
  return (after) =>
    !!after.computers?.some((computer) => !known.has(computer.burrowId));
}

/** What the latest account lookup found: none yet, a failure, or the login. */
export type Lookup = "pending" | "failed" | "signed-in" | "signed-out";

/**
 * Whether the pre-launch notice replaces the sign-in form: only while the
 * latest lookup succeeded and found no login, never on a lookup that failed
 * or has not answered, whatever error the page shows or has cleared.
 */
export const preLaunchNotice = (lookup: Lookup, signInOpen: boolean) =>
  lookup === "signed-out" && !signInOpen;

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
 * The error a step that reads nothing (a new link, Don't approve) leaves: a
 * failed read's, still unanswered, and none in place of any other.
 */
export const keepRead = (error: PageError | null) =>
  error?.read ? error : null;

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

/** How {@link settle} stopped: a read's end, or no read ended it. */
export type Settled<R> = { ended: R } | "timeout" | "cancelled";

const delay = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Reads every `intervalMs` until `end` maps a read to something other than
 * null, `timeoutMs` passes, or `cancelled()` holds. A read that fails, or
 * resolves `undefined` (one a newer read superseded), only waits for the next.
 */
export async function settle<T, R>(
  read: () => Promise<T | undefined>,
  end: (value: T) => R | null,
  options: {
    intervalMs: number;
    timeoutMs: number;
    cancelled: () => boolean;
    wait?: (ms: number) => Promise<void>;
  },
): Promise<Settled<R>> {
  const { intervalMs, timeoutMs, cancelled, wait = delay } = options;
  for (let waited = 0; waited < timeoutMs; waited += intervalMs) {
    await wait(intervalMs);
    if (cancelled()) return "cancelled";
    const value = await read().catch(() => undefined);
    if (cancelled()) return "cancelled";
    const ended = value === undefined ? null : end(value);
    if (ended !== null) return { ended };
  }
  return "timeout";
}

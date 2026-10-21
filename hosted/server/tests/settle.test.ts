import { describe, expect, it, vi } from "vitest";
import {
  ReadFailed,
  afterRead,
  approvalShows,
  asRead,
  keepRead,
  pageError,
  preLaunchNotice,
  reread,
  settle,
  type AccountState,
} from "../../src/settle";

const computer = (burrowId: string) => ({ burrowId, enrolledAt: "2026-10-20" });
const state = (on: boolean | null, ids: string[] | null): AccountState => ({
  voice: on === null ? null : { entitled: true, on },
  computers: ids && ids.map(computer),
});

describe("approvalShows", () => {
  it("waits on a voice approval until Natural Voice is on", () => {
    const shows = approvalShows("voice", state(false, []))!;
    expect(shows(state(false, []))).toBe(false);
    expect(shows(state(null, []))).toBe(false);
    expect(shows(state(true, []))).toBe(true);
  });

  it("has nothing to wait on when Natural Voice is already on", () => {
    expect(approvalShows("voice", state(true, []))).toBeNull();
  });

  it("waits on a remote approval until a computer not listed before appears", () => {
    const shows = approvalShows("remote", state(false, ["a", "b"]))!;
    expect(shows(state(false, ["a", "b"]))).toBe(false);
    expect(shows(state(false, ["a"]))).toBe(false);
    expect(shows(state(false, null))).toBe(false);
    expect(shows(state(false, ["c", "a"]))).toBe(true);
  });

  it("has nothing to compare a remote approval with when no list was read", () => {
    expect(approvalShows("remote", state(false, null))).toBeNull();
  });
});

describe("preLaunchNotice", () => {
  it("shows only once a lookup succeeded and found no login", () => {
    expect(preLaunchNotice("signed-out", false)).toBe(true);
    expect(preLaunchNotice("signed-in", false)).toBe(false);
    expect(preLaunchNotice("failed", false)).toBe(false);
    expect(preLaunchNotice("pending", false)).toBe(false);
  });

  it("never replaces a sign-in form the URL opened", () => {
    expect(preLaunchNotice("signed-out", true)).toBe(false);
  });
});

describe("read errors", () => {
  it("marks a failed read's error as one, keeping its message", async () => {
    await expect(asRead(Promise.resolve(1))).resolves.toBe(1);
    const failed = await asRead(Promise.reject(new Error("offline"))).catch(
      (error: unknown) => error,
    );
    expect(failed).toBeInstanceOf(ReadFailed);
    expect(pageError(failed)).toEqual({ message: "offline", read: true });
  });

  it("marks an action's error as not a read's", () => {
    expect(pageError(new Error("Computer not found."))).toEqual({
      message: "Computer not found.",
      read: false,
    });
    expect(pageError("thrown")).toEqual({
      message: "Something went wrong. Please try again.",
      read: false,
    });
  });

  it("keeps only a failed read's error through a step that reads nothing", () => {
    const read = { message: "offline", read: true };
    expect(keepRead(read)).toBe(read);
    expect(keepRead({ message: "Computer not found.", read: false })).toBeNull();
    expect(keepRead(null)).toBeNull();
  });

  it("clears only a failed read's error on a successful read", () => {
    const action = { message: "Computer not found.", read: false };
    expect(afterRead({ message: "offline", read: true })).toBeNull();
    expect(afterRead(action)).toBe(action);
    expect(afterRead(null)).toBeNull();
  });
});

describe("reread", () => {
  it("resolves the read, telling nothing failed", async () => {
    const failed = vi.fn();
    await expect(reread(async () => 1, failed)).resolves.toBe(1);
    expect(failed).not.toHaveBeenCalled();
  });

  it("reports a failed read itself and resolves, so the mutation stays a success", async () => {
    const failed = vi.fn();
    await expect(
      reread(() => Promise.reject(new Error("offline")), failed),
    ).resolves.toBeUndefined();
    expect(failed).toHaveBeenCalledOnce();
  });
});

describe("settle", () => {
  const options = (cancelled = () => false) => ({
    intervalMs: 5000,
    timeoutMs: 20_000,
    cancelled,
    wait: vi.fn(async () => {}),
  });

  it("reads after each interval until a read shows the change", async () => {
    const read = vi
      .fn<() => Promise<number | undefined>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(undefined)
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);
    const opts = options();
    // Never handed a missed read: `toFixed` throws on one.
    const done = (value: number) => value.toFixed() === "2";
    await expect(settle(read, done, opts)).resolves.toBe("done");
    expect(read).toHaveBeenCalledTimes(4);
    expect(opts.wait).toHaveBeenCalledTimes(4);
    expect(opts.wait).toHaveBeenCalledWith(5000);
  });

  it("gives up once the timeout's reads all missed", async () => {
    const read = vi.fn(async () => 0);
    await expect(settle(read, () => false, options())).resolves.toBe("timeout");
    expect(read).toHaveBeenCalledTimes(4);
  });

  it("stops without reading again once cancelled", async () => {
    const unread = vi.fn(async () => 1);
    await expect(settle(unread, () => true, options(() => true))).resolves.toBe(
      "cancelled",
    );
    expect(unread).not.toHaveBeenCalled();
    let cancelled = false;
    const read = vi.fn(async () => {
      cancelled = true;
      return 1;
    });
    await expect(
      settle(read, () => true, options(() => cancelled)),
    ).resolves.toBe("cancelled");
    expect(read).toHaveBeenCalledTimes(1);
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_ENROLLED_BURROWS } from "../../remote-lib-common/src/remote/enrolled-computers.ts";
import { NOT_ENTITLED_ERROR } from "../../remote-lib-common/src/remote/wire.ts";
import { NoPlanError, approveEnrollment } from "./api";
import { approvedNotice } from "./enrollment";

describe("approvedNotice", () => {
  it("says the computer signs in when the account has room", () => {
    expect(approvedNotice("ABCD-EFGH", MAX_ENROLLED_BURROWS - 1)).toBe(
      "Approved ABCD-EFGH. Dormouse on your computer signs in within a few seconds.",
    );
    expect(approvedNotice("ABCD-EFGH", null)).toContain("signs in within a few seconds");
  });

  it("sends a full account to remove a computer first", () => {
    expect(approvedNotice("ABCD-EFGH", MAX_ENROLLED_BURROWS)).toBe(
      `Approved ABCD-EFGH, but this account already has ${MAX_ENROLLED_BURROWS} computers. Remove one below and Dormouse on your computer signs in on its own.`,
    );
  });
});

describe("approveEnrollment", () => {
  afterEach(() => vi.unstubAllGlobals());
  const answer = (status: number, message: string) =>
    vi.stubGlobal("fetch", async () => Response.json({ message }, { status }));

  it("names a refusal for want of a plan, so the page offers the plans", async () => {
    answer(403, NOT_ENTITLED_ERROR);
    await expect(approveEnrollment("ABCD-EFGH")).rejects.toBeInstanceOf(NoPlanError);
  });

  it("passes any other refusal through as the server wrote it", async () => {
    answer(403, "Sign in again to approve a computer.");
    const refusal = approveEnrollment("ABCD-EFGH");
    await expect(refusal).rejects.not.toBeInstanceOf(NoPlanError);
    await expect(refusal).rejects.toThrow("Sign in again to approve a computer.");
  });
});

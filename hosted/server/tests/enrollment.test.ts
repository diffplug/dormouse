import { afterEach, expect, it, vi } from "vitest";
import { takeEnrollment } from "../../src/enrollment";

afterEach(() => vi.unstubAllGlobals());

it.each([
  ["?purpose=voice", "voice"],
  ["", undefined],
])("retains the approval purpose from %s while erasing its code from history", (search, purpose) => {
  vi.stubGlobal("location", { pathname: "/enroll", search, hash: "#7KQM-X4TD" });
  const replaceState = vi.fn();
  vi.stubGlobal("history", { replaceState });
  expect(takeEnrollment()).toEqual({ code: "7KQM-X4TD", ...(purpose ? { purpose } : {}) });
  expect(replaceState).toHaveBeenCalledWith(null, "", `/enroll${search}`);
});

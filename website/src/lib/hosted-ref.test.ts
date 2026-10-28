/** @vitest-environment jsdom */
import { afterEach, describe, expect, it } from "vitest";
import { takeVisitRef } from "./hosted-ref";

afterEach(() => history.replaceState(null, "", "/"));

describe("takeVisitRef", () => {
  it("answers one of our refs, any other value as other, and none as null", () => {
    history.replaceState(null, "", "/hosted/?ref=readme");
    expect(takeVisitRef()).toBe("readme");
    history.replaceState(null, "", "/hosted/?ref=ada%40example.test");
    expect(takeVisitRef()).toBe("other");
    history.replaceState(null, "", "/hosted/");
    expect(takeVisitRef()).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { coalesceCwds } from "./coalesce-cwds";

describe("coalesceCwds", () => {
  it("turns the Walls' concurrent asks into one invoke", async () => {
    // The quit flush fans out to every Wall at once; on macOS each uncoalesced
    // request is another `lsof` on the sidecar's only event loop.
    const calls: string[][] = [];
    const getCwds = coalesceCwds(async (ids) => {
      calls.push(ids);
      return Object.fromEntries(ids.map((id) => [id, `/cwd/${id}`]));
    });

    const [a, b] = await Promise.all([getCwds(["p1", "p2"]), getCwds(["p3"])]);

    expect(calls).toEqual([["p1", "p2", "p3"]]);
    // Each caller still gets exactly the ids it asked for.
    expect(a).toEqual({ p1: "/cwd/p1", p2: "/cwd/p2" });
    expect(b).toEqual({ p3: "/cwd/p3" });
  });

  it("answers null for an id the host did not resolve", async () => {
    const getCwds = coalesceCwds(async () => ({ p1: "/one" }));

    await expect(getCwds(["p1", "p2"])).resolves.toEqual({ p1: "/one", p2: null });
  });

  it("does not fold a later save into a request already in flight", async () => {
    const calls: string[][] = [];
    const getCwds = coalesceCwds(async (ids) => {
      calls.push(ids);
      return {};
    });

    await getCwds(["p1"]);
    await getCwds(["p2"]);

    expect(calls).toEqual([["p1"], ["p2"]]);
  });
});
